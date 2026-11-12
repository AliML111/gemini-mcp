import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionAudit, auditMetadata, auditResultMetadata, fingerprintClient } from '../src/execution-audit.mjs';

test('execution audit appends sanitized structured records without raw arguments or results', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-audit-test-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const path = join(dir, 'audit.jsonl');
  const logger = new ExecutionAudit(path);
  await logger.open();
  const secret = 'top-secret-command-and-token';
  const metadata = auditMetadata('run_sandbox_session', {
    commands: [secret, 'date'], internet_access: true, password: secret,
  });
  await Promise.all([
    logger.record({
      ...metadata, event: 'tool.started', client_fingerprint: fingerprintClient('test-client'),
      request_id: 'c87148e0-9f8e-4f45-a89d-92214d1e9c4b',
      rawArguments: secret, output: secret, authorization: secret,
    }),
    logger.record({
      ...metadata, event: 'tool.finished', outcome: 'failure', exit_code: 4,
      duration_ms: 10, stderr: secret, path: secret,
    }),
  ]);
  await logger.close();
  const bytes = await readFile(path, 'utf8');
  assert.ok(!bytes.includes(secret));
  const events = bytes.trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.event), ['tool.started', 'tool.finished']);
  assert.equal(events[0].batch_size, 2);
  assert.equal(events[0].network_requested, true);
  assert.equal(events[1].exit_code, 4);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o077, 0);
});

test('deferred finish records are drained on close without waiting in the caller', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-audit-deferred-test-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const path = join(dir, 'audit.jsonl');
  const logger = new ExecutionAudit(path);
  await logger.open();
  await logger.record({ event: 'tool.started', tool: 'read_file' });
  void logger.recordDeferred({ event: 'tool.finished', tool: 'read_file', outcome: 'success', duration_ms: 5 });
  await logger.close();
  const events = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => event.event), ['tool.started', 'tool.finished']);
});

test('audit refuses symlink and cannot proceed without an open audit file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-audit-test-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const original = join(dir, 'original');
  const target = join(dir, 'symlink');
  const file = new ExecutionAudit(original);
  await assert.rejects(file.record({ event: 'tool.started' }), /not open/);
  await file.open();
  await file.close();
  try {
    await symlink(original, target);
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error.code)) {
      t.skip('Creating symbolic links requires Windows Developer Mode or elevation.');
      return;
    }
    throw error;
  }
  await assert.rejects(new ExecutionAudit(target).open(), /ELOOP|symbolic link|symlink/);
});

test('result classification records shell failures and timeout without recording stdout', () => {
  assert.deepEqual(auditResultMetadata({
    structuredContent: {
      results: [{ exit_code: 0, stdout: 'secret' }, { exit_code: 124, stderr: 'secret', timed_out: true }],
    },
  }), { outcome: 'failure', exit_code: 124, timed_out: true });
  assert.deepEqual(auditResultMetadata({
    content: [{ type: 'text', text: 'Fresh disposable gVisor sandbox; network disabled.\nExit code: 1\nOutput:\nsecret' }],
  }), { outcome: 'failure', exit_code: 1, timed_out: false });
  assert.equal(auditResultMetadata({ structuredContent: { passed: false } }).outcome, 'failure');
  assert.equal(auditResultMetadata({ isError: true }).outcome, 'failure');
});
