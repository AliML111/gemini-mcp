/**
 * Append-only JSONL audit trail. Never serialize user arguments, commands,
 * filesystem paths, authorization headers, tool output or token values.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function restrictWindowsAuditFile(path) {
  const { stdout } = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', maxBuffer: 4_096, timeout: 5_000, windowsHide: true,
  });
  const userSid = /\bS-1-\d+(?:-\d+)+\b/.exec(stdout)?.[0];
  if (!userSid) throw new Error('Could not determine the current Windows account SID for the audit log.');
  await execFileAsync('icacls.exe', [
    path,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:F`,
    '*S-1-5-18:F',
    '*S-1-5-32-544:F',
  ], { encoding: 'utf8', maxBuffer: 4_096, timeout: 5_000, windowsHide: true });
}

const knownEvents = new Set(['tool.started', 'tool.finished', 'tool.denied']);
const knownOutcomes = new Set(['success', 'failure', 'denied']);
const allowedFields = new Set([
  'event', 'tool', 'outcome', 'duration_ms', 'http_status', 'capability',
  'exit_code', 'timed_out', 'network_requested', 'batch_size', 'client_fingerprint',
  'request_id',
]);
const allowedTools = /^[a-z][A-Za-z0-9_-]{0,79}$/;
const allowedCapability = /^[a-z][a-z0-9:_-]{0,79}$/;

export function fingerprintClient(clientId) {
  if (typeof clientId !== 'string' || !clientId) return null;
  return createHash('sha256').update(clientId).digest('hex').slice(0, 16);
}

export function auditMetadata(tool, args = {}) {
  if (typeof tool !== 'string' || !allowedTools.test(tool)) return {};
  const safe = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const result = { tool };
  if (tool === 'run_sandbox_bash' || tool === 'run_sandbox_session' || tool === 'start_project_session') {
    result.network_requested = safe.internet_access === true;
  }
  if (tool === 'run_sandbox_session' || tool === 'run_host_commands') {
    result.batch_size = Array.isArray(safe.commands) ? Math.min(safe.commands.length, 4) : 0;
  }
  return result;
}

export function auditResultMetadata(result) {
  const report = result?.structuredContent;
  if (report && typeof report === 'object') {
    if (Array.isArray(report.results)) {
      const codes = report.results.map((value) => value?.exit_code);
      const firstFailure = codes.find((value) => Number.isInteger(value) && value !== 0);
      return {
        outcome: report.error || report.passed === false || firstFailure !== undefined ? 'failure' : 'success',
        ...(firstFailure !== undefined ? { exit_code: firstFailure } : {}),
        timed_out: report.results.some((value) => value?.timed_out === true),
      };
    }
    if (report.passed === false) return { outcome: 'failure' };
    if (report.error) return { outcome: 'failure' };
  }
  if (result?.isError === true) return { outcome: 'failure' };
  // The single Bash tool returns text; parse only the generated exit status.
  const message = result?.content?.[0]?.text;
  if (typeof message === 'string' && message.startsWith('Fresh disposable gVisor sandbox;')) {
    const match = /(?:^|\n)Exit code: (\d+)(?:\n|$)/.exec(message);
    if (match) {
      const code = Number(match[1]);
      return { outcome: code === 0 ? 'success' : 'failure', exit_code: code, timed_out: code === 124 };
    }
  }
  return { outcome: 'success' };
}

export class ExecutionAudit {
  constructor(path) {
    if (!isAbsolute(path)) throw new Error('MCP_AUDIT_LOG must be an absolute path.');
    this.path = path;
    this.file = null;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.bytes = 0;
    this.closing = false;
  }

  async open() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
    const file = await open(this.path, flags, 0o600);
    try {
      if (process.platform === 'win32') await restrictWindowsAuditFile(this.path);
      const stat = await file.stat();
      if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
        throw new Error('Audit log must be a regular file with private permissions.');
      }
      this.file = file;
      this.bytes = stat.size;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  record(fields) {
    if (this.closing || !this.file) return Promise.reject(new Error('Audit log is not open.'));
    if (this.pending >= 256) return Promise.reject(new Error('Audit queue is full.'));
    // Explicit field and type allowlist: accidental arguments/output cannot be logged.
    const safe = { timestamp: new Date().toISOString(), schema: 'gemini-mcp.audit.v1' };
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (!allowedFields.has(key)) continue;
      if (key === 'event' && knownEvents.has(value)) safe[key] = value;
      else if (key === 'outcome' && knownOutcomes.has(value)) safe[key] = value;
      else if (key === 'tool' && typeof value === 'string' && allowedTools.test(value)) safe[key] = value;
      else if (key === 'capability' && typeof value === 'string' && allowedCapability.test(value)) safe[key] = value;
      else if (['duration_ms', 'http_status', 'exit_code', 'batch_size'].includes(key)
        && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
      else if (['timed_out', 'network_requested'].includes(key) && typeof value === 'boolean') safe[key] = value;
      else if (key === 'client_fingerprint' && typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)) safe[key] = value;
      else if (key === 'request_id' && typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) safe[key] = value;
    }
    if (!knownEvents.has(safe.event)) return Promise.reject(new Error('Invalid audit event.'));
    const line = JSON.stringify(safe) + '\n';
    const size = Buffer.byteLength(line);
    const write = async () => {
      if (!this.file) await this.open();
      if (this.bytes + size > 16 * 1024 * 1024) {
        await this.file.close();
        this.file = null;
        try {
          await rename(this.path, this.path + '.1');
        } finally {
          await this.open();
        }
      }
      await this.file.writeFile(line, { encoding: 'utf8' });
      this.bytes += size;
    };
    this.pending += 1;
    this.queue = this.queue.then(write, write).finally(() => { this.pending -= 1; });
    return this.queue;
  }

  recordDeferred(fields) {
    return this.record(fields).catch((error) => {
      console.error('Execution audit background write failed:', error.message);
    });
  }

  async close() {
    this.closing = true;
    await this.queue.catch(() => {});
    if (this.file) await this.file.close();
    this.file = null;
  }
}

export function newAuditRequestId() {
  return randomUUID();
}
