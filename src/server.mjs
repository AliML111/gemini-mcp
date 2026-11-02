import { execFile, spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SandboxManager } from './sandbox-manager.mjs';
import { initializeFilesystemBackend } from './filesystem-backend.mjs';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const port = Number.parseInt(process.env.MCP_PORT ?? '8787', 10);
const endpointPath = process.env.MCP_PATH ?? '/mcp';
const sandboxImage = 'gemini-mcp-sandbox:0.1.0';
const managedLabel = 'gemini-mcp-poc.managed=true';
const sandboxRuntime = 'runsc';
const sandboxSystemdSlice = 'app-gemini-mcp-sandbox.slice';
const sandboxRunscWrapperPath = fileURLToPath(new URL('../scripts/runsc-scope-wrapper.sh', import.meta.url));
const sandboxTimeoutSeconds = 5;
const hostCommandTimeoutMs = sandboxTimeoutSeconds * 1_000;
const sandboxMaxOutputBytes = 64 * 1024;
const sandboxMaxSessionCommands = 4;
const sandboxContainerLimits = {
  cpu: '25000 100000',
  memory: String(256 * 1024 * 1024),
  swap: '0',
  tasks: '64',
};
const sandboxServiceLimits = {
  cpu: '100000 100000',
  memory: '805306368',
  swap: '0',
  tasks: '256',
};
const sandboxSliceLimits = {
  cpu: '100000 100000',
  memory: String(1536 * 1024 * 1024),
  swap: '0',
  tasks: '512',
};
const maxSandboxConcurrency = 2;
const maxSandboxWorkspaces = 2;
const workspaceIdleTtlMs = Number.parseInt(process.env.SANDBOX_WORKSPACE_IDLE_TTL_MS ?? `${15 * 60 * 1000}`, 10);
const workspaceMaxLifetimeMs = Number.parseInt(process.env.SANDBOX_WORKSPACE_MAX_LIFETIME_MS ?? `${60 * 60 * 1000}`, 10);
const taskWorkspaceIdleTtlMs = Number.parseInt(process.env.SANDBOX_TASK_IDLE_TTL_MS ?? `${30 * 60 * 1000}`, 10);
const taskWorkspaceMaxLifetimeMs = Number.parseInt(process.env.SANDBOX_TASK_MAX_LIFETIME_MS ?? `${4 * 60 * 60 * 1000}`, 10);
const workspaceLifecyclePolicies = {
  conversation: { idleTtlMs: workspaceIdleTtlMs, maxLifetimeMs: workspaceMaxLifetimeMs },
  task: { idleTtlMs: taskWorkspaceIdleTtlMs, maxLifetimeMs: taskWorkspaceMaxLifetimeMs },
};
const maxToolCallsPerMinute = 30;
const requestedBackends = process.env.MCP_BACKENDS?.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  ?? ['docker'];
const supportedBackends = new Set(['docker', 'bash', 'powershell', 'filesystem']);
if (requestedBackends.length === 0 || requestedBackends.some((backend) => !supportedBackends.has(backend))) {
  throw new Error('MCP_BACKENDS must be a comma-separated list containing docker, bash, powershell, and/or filesystem.');
}
if (new Set(requestedBackends).size !== requestedBackends.length) {
  throw new Error('MCP_BACKENDS must not contain duplicate backends.');
}
let sandboxDockerHost = null;
const stateDbPath = process.env.SANDBOX_STATE_DB
  ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'gemini-mcp', 'sandboxes.sqlite');
let workspaceManager = null;
let workspaceCleanupTimer = null;
let filesystemBackend = null;
const hostShellExecutables = new Map();
let enabledBackends = [];
let activeToolExecutions = 0;
let toolCallWindowStartedAt = Date.now();
let toolCallsInWindow = 0;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MCP_PORT must be a valid TCP port.');
}
if (!endpointPath.startsWith('/') || endpointPath.includes('?') || endpointPath.includes('#')) {
  throw new Error('MCP_PATH must be an absolute URL path.');
}
for (const [lifecycle, policy] of Object.entries(workspaceLifecyclePolicies)) {
  if (!Number.isSafeInteger(policy.idleTtlMs) || policy.idleTtlMs < 1_000
    || !Number.isSafeInteger(policy.maxLifetimeMs) || policy.maxLifetimeMs < policy.idleTtlMs) {
    throw new Error(`Workspace TTL values for ${lifecycle} must be valid milliseconds, with max lifetime >= idle TTL.`);
  }
}

function defaultSandboxDockerHost() {
  if (process.env.SANDBOX_DOCKER_HOST) return process.env.SANDBOX_DOCKER_HOST;
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    throw new Error('The managed Docker backend requires Linux with rootless Docker, gVisor, and user systemd.');
  }
  return `unix://${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`}/docker.sock`;
}

async function docker(args, options = {}) {
  return execFileAsync('docker', ['--host', sandboxDockerHost, ...args], {
    timeout: 5_000,
    maxBuffer: sandboxMaxOutputBytes * 2,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
}

async function readCgroupLimits(controlGroup) {
  const cgroupDirectory = join('/sys/fs/cgroup', controlGroup.replace(/^\/+/, ''));
  const [cpuLimit, memoryLimit, swapLimit, taskLimit] = await Promise.all([
    readFile(join(cgroupDirectory, 'cpu.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'memory.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'memory.swap.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'pids.max'), 'utf8'),
  ]);
  return {
    cpu: cpuLimit.trim(),
    memory: memoryLimit.trim(),
    swap: swapLimit.trim(),
    tasks: taskLimit.trim(),
  };
}

function assertCgroupLimits(description, actual, expected) {
  if (Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new Error(`Refusing to start: ${description} are not active. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

async function verifyPerContainerResourceLimits(sliceControlGroup) {
  const containerName = `gemini-mcp-resource-probe-${randomUUID()}`;
  try {
    await docker([
      'run', '--detach', '--rm',
      ...sandboxContainerArgs(containerName, ['gemini-mcp-poc.resource-probe=true']),
      sandboxImage,
      '/bin/sh', '-c', 'sleep 30',
    ], { timeout: 15_000 });

    const { stdout: inspectOutput } = await docker(['inspect', containerName]);
    const [container] = JSON.parse(inspectOutput);
    const config = container.HostConfig;
    if (config.Memory !== Number(sandboxContainerLimits.memory)
      || config.MemorySwap !== Number(sandboxContainerLimits.memory)
      || config.NanoCpus !== 250_000_000
      || config.PidsLimit !== Number(sandboxContainerLimits.tasks)) {
      throw new Error(`Docker did not retain the requested container resource settings: ${JSON.stringify({
        memory: config.Memory,
        memorySwap: config.MemorySwap,
        nanoCpus: config.NanoCpus,
        pidsLimit: config.PidsLimit,
      })}.`);
    }

    const pid = container.State.Pid;
    if (!Number.isInteger(pid) || pid < 1) {
      throw new Error('The resource-probe container has no live host PID.');
    }
    const cgroupText = await readFile(`/proc/${pid}/cgroup`, 'utf8');
    const cgroupPath = cgroupText.split('\n').find((line) => line.startsWith('0::'))?.slice(3);
    if (!cgroupPath?.startsWith(`${sliceControlGroup}/`) || !cgroupPath.endsWith('.scope')) {
      throw new Error(`The gVisor process is outside its dedicated systemd scope. Expected a scope below ${sliceControlGroup}, got ${cgroupPath ?? 'no cgroup path'}.`);
    }

    const actual = await readCgroupLimits(cgroupPath);
    assertCgroupLimits('per-container systemd-scope resource limits', actual, sandboxContainerLimits);
  } catch (error) {
    throw new Error(`Refusing to start: per-container gVisor resource limits could not be verified. ${error.message}`);
  } finally {
    await docker(['rm', '--force', containerName], { timeout: 3_000 }).catch(() => {});
  }
}

async function ensureSandboxBackend() {
  const [securityOptionsResult, runtimesResult] = await Promise.all([
    docker(['info', '--format', '{{json .SecurityOptions}}']),
    docker(['info', '--format', '{{json .Runtimes}}']),
  ]);
  const securityOptions = JSON.parse(securityOptionsResult.stdout);
  const runtimes = JSON.parse(runtimesResult.stdout);
  if (!securityOptions.includes('name=rootless')) {
    throw new Error(`Refusing to start: ${sandboxDockerHost} is not a rootless Docker daemon.`);
  }
  if (!securityOptions.some((option) => option.startsWith('name=seccomp'))) {
    throw new Error('Refusing to start: the rootless Docker daemon reports no seccomp support.');
  }
  if (!Object.hasOwn(runtimes, sandboxRuntime)) {
    throw new Error(`Refusing to start: the rootless Docker daemon has no ${sandboxRuntime} runtime configured.`);
  }
  if (runtimes[sandboxRuntime].path !== sandboxRunscWrapperPath) {
    throw new Error(`Refusing to start: Docker's ${sandboxRuntime} runtime must use ${sandboxRunscWrapperPath} so each sandbox gets its own resource-limited systemd scope.`);
  }

  const [controlGroupResult, sliceControlGroupResult] = await Promise.all([
    execFileAsync('systemctl', ['--user', 'show', 'docker.service', '--property=ControlGroup', '--value'],
      { timeout: 5_000, encoding: 'utf8' }),
    execFileAsync('systemctl', ['--user', 'show', sandboxSystemdSlice, '--property=ControlGroup', '--value'],
      { timeout: 5_000, encoding: 'utf8' }),
  ]);
  const controlGroup = controlGroupResult.stdout.trim();
  const sliceControlGroup = sliceControlGroupResult.stdout.trim();
  const expectedPrefix = `/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/`;
  if (!controlGroup.startsWith(expectedPrefix) || controlGroup.split('/').includes('..')
    || !sliceControlGroup.startsWith(expectedPrefix) || sliceControlGroup.split('/').includes('..')
    || !controlGroup.startsWith(`${sliceControlGroup}/`)) {
    throw new Error('Refusing to start: the dedicated rootless Docker daemon is not inside the expected user systemd cgroup.');
  }
  assertCgroupLimits('rootless Docker service cgroup limits', await readCgroupLimits(controlGroup), sandboxServiceLimits);
  assertCgroupLimits('sandbox aggregate systemd-slice limits', await readCgroupLimits(sliceControlGroup), sandboxSliceLimits);
  await verifyPerContainerResourceLimits(sliceControlGroup);
}

function sandboxContainerArgs(containerName, extraLabels = [], internetAccess = false) {
  return [
    '--init',
    '--pull=never',
    '--name', containerName,
    '--label', managedLabel,
    ...extraLabels.flatMap((label) => ['--label', label]),
    `--runtime=${sandboxRuntime}`,
    '--memory=256m',
    '--memory-swap=256m',
    '--cpus=0.25',
    '--pids-limit=64',
    internetAccess ? '--network=bridge' : '--network=none',
    '--read-only',
    '--user=10001:10001',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true',
    '--ulimit=nofile=256:256',
    '--log-driver=none',
    '--stop-timeout=1',
    '--shm-size=8m',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,uid=10001,gid=10001,mode=1777',
    '--tmpfs=/workspace:rw,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700',
    '--workdir=/workspace',
    '--hostname=sandbox',
  ];
}

function formatSandboxOutput(stdout = '', stderr = '') {
  const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n') || '(no output)';
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.byteLength <= sandboxMaxOutputBytes) return output;
  const marker = Buffer.from('\n[output truncated at 64 KiB]', 'utf8');
  return `${bytes.subarray(0, sandboxMaxOutputBytes - marker.byteLength).toString('utf8')}${marker.toString('utf8')}`;
}

function sandboxResultMessage({ stdout = '', stderr = '', exitCode = 0, internetAccess = false, note = '' }) {
  const network = internetAccess ? 'outbound network enabled' : 'network disabled';
  const exit = exitCode === 0 ? 'Exit code: 0' : `Exit code: ${exitCode}`;
  return `Fresh disposable gVisor sandbox; ${network}; container removed after this call.\n${note}${note ? '\n' : ''}${exit}\nOutput:\n${formatSandboxOutput(stdout, stderr)}`;
}

async function runSandboxBash(command, internetAccess = false) {
  if (Buffer.byteLength(command, 'utf8') > 1_000) {
    throw new Error('Sandbox command must be at most 1,000 UTF-8 bytes.');
  }
  if (activeToolExecutions >= maxSandboxConcurrency) {
    throw new Error('Sandbox is at capacity. Retry after another run finishes.');
  }

  const containerName = `gemini-mcp-run-${randomUUID()}`;
  activeToolExecutions += 1;
  const execution = [
    '/usr/bin/timeout', '-s', 'TERM', '-k', '1s', `${sandboxTimeoutSeconds}s`,
    '/bin/bash', '--noprofile', '--norc', '-c', command,
  ];
  try {
    const dockerArgs = ['run', '--rm', ...sandboxContainerArgs(containerName, [], internetAccess), sandboxImage, ...execution];
    try {
      const result = await docker(dockerArgs, { timeout: 8_000, maxBuffer: sandboxMaxOutputBytes * 2 });
      return sandboxResultMessage({ stdout: result.stdout, stderr: result.stderr, internetAccess });
    } catch (error) {
      const stdout = typeof error.stdout === 'string' ? error.stdout : '';
      const stderr = typeof error.stderr === 'string' ? error.stderr : '';
      if (error.code === 124) {
        return sandboxResultMessage({
          stdout, stderr, exitCode: 124, internetAccess,
          note: `Command exceeded the ${sandboxTimeoutSeconds}-second execution limit.`,
        });
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return sandboxResultMessage({
          stdout, stderr, exitCode: 1, internetAccess,
          note: `Output exceeded the ${sandboxMaxOutputBytes}-byte capture limit.`,
        });
      }
      if (Number.isInteger(error.code)) {
        return sandboxResultMessage({ stdout, stderr, exitCode: error.code, internetAccess });
      }
      if (error.killed || error.code === 'ETIMEDOUT') {
        return sandboxResultMessage({
          exitCode: 124,
          internetAccess,
          note: 'Docker exceeded the 8-second outer safety limit; the disposable container was removed.',
        });
      }
      throw new Error(`Could not start the gVisor sandbox using the dedicated rootless Docker daemon. ${error.message}`);
    }
  } finally {
    await docker(['rm', '--force', containerName], { timeout: 3_000 }).catch(() => {});
    activeToolExecutions -= 1;
  }
}

function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  return bytes.subarray(0, Math.max(0, maxBytes)).toString('utf8');
}

function serializeSessionReport(report) {
  let serialized = JSON.stringify(report);
  while (Buffer.byteLength(serialized, 'utf8') > sandboxMaxOutputBytes) {
    const candidates = report.results.flatMap((result) => ['stdout', 'stderr']
      .map((field) => ({ result, field, size: Buffer.byteLength(result[field], 'utf8') }))
      .filter((item) => item.size > 0))
      .sort((left, right) => right.size - left.size);
    const largest = candidates[0];
    if (!largest) throw new Error('Sandbox session report exceeds the output limit.');
    largest.result[largest.field] = truncateUtf8(largest.result[largest.field], Math.floor(largest.size * 0.7));
    largest.result.output_truncated = true;
    report.output_truncated = true;
    serialized = JSON.stringify(report);
  }
  return serialized;
}

async function executeSessionCommand(containerName, command) {
  const execution = [
    '/usr/bin/timeout', '-s', 'TERM', '-k', '1s', `${sandboxTimeoutSeconds}s`,
    '/bin/bash', '--noprofile', '--norc', '-c', command,
  ];
  try {
    const result = await docker([
      'exec', '--user=10001:10001', '--workdir=/workspace', containerName, ...execution,
    ], { timeout: 8_000, maxBuffer: sandboxMaxOutputBytes * 2 });
    return { exit_code: 0, timed_out: false, stdout: result.stdout, stderr: result.stderr, output_truncated: false };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    if (Number.isInteger(error.code)) {
      if (/no such container|container .* is not running|error response from daemon/i.test(stderr)) {
        throw new Error(`Sandbox container is not running: ${stderr.trim()}`);
      }
      return { exit_code: error.code, timed_out: error.code === 124, stdout, stderr, output_truncated: false };
    }
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return {
        exit_code: 1, timed_out: false, stdout, stderr: `${stderr}\nOutput exceeded the ${sandboxMaxOutputBytes}-byte capture limit.`,
        output_truncated: true,
      };
    }
    if (error.killed || error.code === 'ETIMEDOUT') {
      const timeoutError = new Error('Docker operation exceeded the 8-second outer safety limit.');
      timeoutError.workspaceTimeout = true;
      throw timeoutError;
    }
    throw new Error(`Could not execute the command in the gVisor session. ${error.message}`);
  }
}

async function runSandboxSession(commands, { sessionId = null, internetAccess, lifecycle } = {}) {
  if (commands.length > sandboxMaxSessionCommands) {
    throw new Error(`A sandbox session call accepts at most ${sandboxMaxSessionCommands} commands.`);
  }
  const commandBytes = commands.reduce((total, command) => total + Buffer.byteLength(command, 'utf8'), 0);
  if (commands.some((command) => Buffer.byteLength(command, 'utf8') > 1_000) || commandBytes > 4_000) {
    throw new Error('Each command must be at most 1,000 UTF-8 bytes and the combined commands at most 4,000 bytes.');
  }
  if (activeToolExecutions >= maxSandboxConcurrency) {
    throw new Error('Sandbox is at capacity. Retry after another run finishes.');
  }
  activeToolExecutions += 1;

  let effectiveSessionId = sessionId;
  let created = false;
  let effectiveLifecycle = lifecycle ?? (sessionId ? null : 'ephemeral');
  let retain = Boolean(sessionId) || effectiveLifecycle !== 'ephemeral';
  let networkAccess = Boolean(internetAccess);
  let cleanupPending = false;
  let cleanupAttempted = false;
  try {
    if (sessionId) {
      const session = workspaceManager.inspect(sessionId);
      if (lifecycle !== undefined && lifecycle !== session.lifecycle) {
        throw new Error(`This session uses the ${session.lifecycle} lifecycle; reuse it without changing lifecycle.`);
      }
      effectiveLifecycle = session.lifecycle;
      if (internetAccess !== undefined && Boolean(session.internet_access) !== internetAccess) {
        throw new Error('Internet access is fixed when a session is created; omit internet_access when reusing it or match its current setting.');
      }
      networkAccess = Boolean(session.internet_access);
    } else {
      if (!['ephemeral', 'conversation', 'task'].includes(effectiveLifecycle)) {
        throw new Error('lifecycle must be ephemeral, conversation, or task.');
      }
      effectiveSessionId = await workspaceManager.create({
        internetAccess: networkAccess,
        lifecycle: effectiveLifecycle === 'ephemeral' ? 'conversation' : effectiveLifecycle,
      });
      created = true;
    }

    const results = await workspaceManager.execute(effectiveSessionId, async (containerName) => {
      const commandResults = [];
      for (const command of commands) {
        commandResults.push({
          command,
          ...await executeSessionCommand(containerName, command),
        });
      }
      return commandResults;
    });

    if (created && !retain) {
      cleanupAttempted = true;
      try { await workspaceManager.remove(effectiveSessionId); }
      catch (error) {
        console.error('Temporary session cleanup failed:', error.message);
        cleanupPending = true;
      }
    }
    const session = retain ? workspaceManager.inspect(effectiveSessionId) : null;
    const report = {
      session_id: retain ? effectiveSessionId : null,
      session_retained: Boolean(retain),
      lifecycle: effectiveLifecycle,
      internet_access: networkAccess,
      expires_at: session?.expires_at ?? null,
      cleanup_pending: cleanupPending,
      error: null,
      output_truncated: false,
      results: results.map((result, index) => ({ index: index + 1, ...result })),
    };
    const text = serializeSessionReport(report);
    return { content: [{ type: 'text', text }], structuredContent: report };
  } catch (error) {
    if (error.workspaceTimeout && effectiveSessionId) {
      cleanupAttempted = true;
      try { await workspaceManager.remove(effectiveSessionId); }
      catch (cleanupError) {
        cleanupPending = true;
        console.error('Timed-out session cleanup failed:', cleanupError.message);
      }
      const report = {
        session_id: null,
        session_retained: false,
        lifecycle: effectiveLifecycle,
        internet_access: networkAccess,
        expires_at: null,
        cleanup_pending: cleanupPending,
        error: 'Docker exceeded the 8-second outer safety limit. The session was discarded; retry with a new session.',
        output_truncated: false,
        results: [],
      };
      return { content: [{ type: 'text', text: JSON.stringify(report) }], structuredContent: report };
    }
    throw error;
  } finally {
    if (!cleanupAttempted && created && !retain && effectiveSessionId && workspaceManager.row(effectiveSessionId)) {
      try { await workspaceManager.remove(effectiveSessionId); }
      catch (error) { console.error('Temporary session cleanup retry failed:', error.message); }
    }
    activeToolExecutions -= 1;
  }
}

async function runHostShellCommand(shell, command, cwd) {
  const executable = hostShellExecutables.get(shell);
  if (!executable) throw new Error(`${shell} was not enabled or detected when this server started.`);
  const args = shell === 'bash'
    ? ['--noprofile', '--norc', '-c', command]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command];
  const child = spawn(executable, args, {
    cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimit = false;
    let terminationRequested = false;
    let killTimer = null;
    let settled = false;
    const terminateTree = () => {
      if (!child.pid || terminationRequested) return;
      terminationRequested = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        return;
      }
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }, 300);
      killTimer.unref();
    };
    const append = (target, chunk) => {
      const remaining = sandboxMaxOutputBytes - outputBytes;
      if (remaining <= 0) {
        outputLimit = true;
        return;
      }
      const kept = chunk.subarray(0, remaining);
      target.push(kept);
      outputBytes += kept.byteLength;
      if (kept.byteLength < chunk.byteLength) outputLimit = true;
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateTree();
    }, hostCommandTimeoutMs);
    timeout.unref();
    child.stdout.on('data', (chunk) => {
      append(stdout, chunk);
      if (outputLimit) terminateTree();
    });
    child.stderr.on('data', (chunk) => {
      append(stderr, chunk);
      if (outputLimit) terminateTree();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exit_code: timedOut ? 124 : outputLimit ? 1 : Number.isInteger(code) ? code : 1,
        timed_out: timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: [Buffer.concat(stderr).toString('utf8'),
          timedOut ? `Command exceeded the ${sandboxTimeoutSeconds}-second execution limit.` : '',
          outputLimit ? `Output exceeded the ${sandboxMaxOutputBytes}-byte capture limit.` : '']
          .filter(Boolean).join('\n'),
        output_truncated: outputLimit,
      });
    });
  });
}

async function runHostCommands(shell, commands, workingDirectory) {
  if (!hostShellExecutables.has(shell)) throw new Error(`${shell} is not available in the enabled host backends.`);
  if (commands.length > sandboxMaxSessionCommands) {
    throw new Error(`A host shell call accepts at most ${sandboxMaxSessionCommands} commands.`);
  }
  const commandBytes = commands.reduce((total, command) => total + Buffer.byteLength(command, 'utf8'), 0);
  if (commands.some((command) => Buffer.byteLength(command, 'utf8') > 1_000) || commandBytes > 4_000) {
    throw new Error('Each command must be at most 1,000 UTF-8 bytes and the combined commands at most 4,000 bytes.');
  }
  if (activeToolExecutions >= maxSandboxConcurrency) {
    throw new Error('Command runner is at capacity. Retry after another run finishes.');
  }
  activeToolExecutions += 1;
  try {
    const requestedDirectory = workingDirectory ?? process.cwd();
    if (!isAbsolute(requestedDirectory)) throw new Error('working_directory must be an absolute path.');
    const cwd = await realpath(requestedDirectory);
    if (!(await stat(cwd)).isDirectory()) throw new Error('working_directory must point to a directory.');
    const results = [];
    for (const [index, command] of commands.entries()) {
      let result;
      try {
        result = await runHostShellCommand(shell, command, cwd);
      } catch (error) {
        result = {
          exit_code: 127,
          timed_out: false,
          stdout: '',
          stderr: `Could not start ${shell}: ${error.message}`,
          output_truncated: false,
        };
      }
      results.push({ index: index + 1, command, ...result });
    }
    const report = {
      backend: shell,
      working_directory: cwd,
      error: null,
      output_truncated: false,
      results,
    };
    return { content: [{ type: 'text', text: serializeSessionReport(report) }], structuredContent: report };
  } finally {
    activeToolExecutions -= 1;
  }
}

function createServer() {
  const instructions = [];
  if (enabledBackends.includes('docker')) {
    instructions.push('For isolated commands, use run_sandbox_bash for one command or run_sandbox_session for up to four commands in one temporary gVisor workspace. The default lifecycle is ephemeral and removes the container after the batch. Choose conversation to retain a session for later calls (15 minutes idle, 60 minutes total) or task for a longer managed workspace (30 minutes idle, 4 hours total); reuse the returned session_id. The server expires and deletes every retained container. Network is off by default; internet_access=true opts a new container into the rootless bridge. Each command is limited to 5 seconds. Managed containers have no host mounts, read-only root, non-root UID, dropped capabilities, no-new-privileges, and per-container resource limits.');
  }
  if (hostShellExecutables.size > 0) {
    instructions.push('run_host_commands executes directly on this MCP server machine with the server user’s full host permissions; it does not use Docker or provide sandbox isolation. Use it only when the user requested work on the host. Commands in a batch run sequentially in the selected shell, each with a fresh process and the same working directory. Each command has a 5-second timeout and output is capped at 64 KiB.');
  }
  if (filesystemBackend) {
    instructions.push(`Filesystem tools are confined to these configured roots: ${filesystemBackend.roots.join(', ')}. Use list_files, read_file, or search_files to inspect; write_file and edit_file can change files only inside these roots. Reads and search results have size limits.`);
  }
  instructions.push('Never include secrets in commands. Gemini approval preferences are controlled by Gemini Connected Apps, not by this MCP server.');
  const server = new McpServer(
    { name: 'gemini-local-bash-poc', version: '0.3.0' },
    { instructions: instructions.join(' ') },
  );

  if (enabledBackends.includes('docker')) {
    server.registerTool(
      'run_sandbox_bash',
      {
        title: 'Run Bash in an isolated gVisor sandbox',
        description:
          'Runs one Bash command in a fresh, disposable gVisor container and removes the container after the call. Network is disabled by default; internet_access=true opts into the rootless Docker bridge. No host mounts; read-only root; UID 10001; no capabilities; no-new-privileges; 256 MiB memory, 0.25 CPU, and 64 host tasks. Each command has a 5-second limit and output is capped at 64 KiB. Use run_sandbox_session for a multi-command workflow or a retained workspace.',
        inputSchema: {
          command: z.string().trim().min(1).max(1_000).describe('Bash command text to run only inside the isolated container; maximum 1,000 UTF-8 bytes.'),
          internet_access: z.boolean().default(false).describe('Set true only when this command needs outbound internet access; default false.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ command, internet_access: internetAccess }) => ({
        content: [{ type: 'text', text: await runSandboxBash(command, internetAccess) }],
      }),
    );

    server.registerTool(
      'run_sandbox_session',
      {
        title: 'Run a batch in a managed sandbox session',
        description:
          'Runs up to four Bash commands sequentially in one gVisor workspace and returns structured results. It runs all commands even if one exits nonzero. Files persist between commands; each command starts a fresh Bash process, so shell variables and current directory do not persist. lifecycle=ephemeral (default) removes the workspace after the batch; lifecycle=conversation retains it for 15 minutes idle or 60 minutes total; lifecycle=task retains it for 30 minutes idle or 4 hours total. A retained call returns session_id for follow-up calls; the server owns expiry and cleanup. Network defaults off; internet_access=true opts a new workspace into the rootless bridge, and cannot be changed when reusing a session. Each command is limited to 1,000 UTF-8 bytes and 5 seconds; the batch is limited to four commands and 4,000 combined command bytes. Containers have no host mounts, read-only root, non-root UID, dropped capabilities, no-new-privileges, 256 MiB memory, 0.25 CPU, and 64 host tasks.',
        inputSchema: {
          commands: z.array(z.string().trim().min(1).max(1_000))
            .min(1).max(sandboxMaxSessionCommands)
            .describe('One to four Bash commands to run in order in the same workspace. Each command is at most 1,000 UTF-8 bytes.'),
          session_id: z.string().uuid().optional()
            .describe('Reuse a session_id returned by an earlier conversation or task lifecycle call.'),
          lifecycle: z.enum(['ephemeral', 'conversation', 'task']).optional()
            .describe('For a new workspace: ephemeral deletes after this batch (default); conversation retains 15m idle/60m total; task retains 30m idle/4h total. Reuse session_id to continue a retained workspace.'),
          internet_access: z.boolean().optional()
            .describe('For a new workspace, set true only when outbound internet is needed; defaults false. Reusing a session keeps its original setting.'),
        },
        outputSchema: {
          session_id: z.string().uuid().nullable(),
          session_retained: z.boolean(),
          lifecycle: z.enum(['ephemeral', 'conversation', 'task']),
          internet_access: z.boolean(),
          expires_at: z.string().nullable(),
          cleanup_pending: z.boolean(),
          error: z.string().nullable(),
          output_truncated: z.boolean(),
          results: z.array(z.object({
            index: z.number().int(),
            command: z.string(),
            exit_code: z.number().int(),
            timed_out: z.boolean(),
            stdout: z.string(),
            stderr: z.string(),
            output_truncated: z.boolean(),
          })),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ commands, session_id: sessionId, lifecycle, internet_access: internetAccess }) => (
        runSandboxSession(commands, { sessionId, lifecycle, internetAccess })
      ),
    );
  }

  if (hostShellExecutables.size > 0) {
    const availableShells = [...hostShellExecutables.keys()];
    server.registerTool(
      'run_host_commands',
      {
        title: 'Run commands directly on the host',
        description:
          'Runs up to four commands directly on the computer running this MCP server in the selected Bash or PowerShell executable. This is full host access as the server user; it is not a sandbox and may read, change, or delete host files. Each command gets a fresh shell process and the same working directory, so shell variables and directory changes do not persist between array entries. Results include each exit code, stdout, and stderr. Each command is limited to 1,000 UTF-8 bytes and 5 seconds; combined input is limited to 4,000 bytes and output to 64 KiB. Use only when the user requests host execution and the endpoint is trusted.',
        inputSchema: {
          shell: z.enum(availableShells),
          commands: z.array(z.string().trim().min(1).max(1_000))
            .min(1).max(sandboxMaxSessionCommands)
            .describe('One to four commands in order. Each command is at most 1,000 UTF-8 bytes; all run on the host.'),
          working_directory: z.string().optional()
            .describe('Optional absolute directory on the host. Defaults to the MCP server current directory.'),
        },
        outputSchema: {
          backend: z.enum(availableShells),
          working_directory: z.string(),
          error: z.string().nullable(),
          output_truncated: z.boolean(),
          results: z.array(z.object({
            index: z.number().int(),
            command: z.string(),
            exit_code: z.number().int(),
            timed_out: z.boolean(),
            stdout: z.string(),
            stderr: z.string(),
            output_truncated: z.boolean(),
          })),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async ({ shell, commands, working_directory: workingDirectory }) => (
        runHostCommands(shell, commands, workingDirectory)
      ),
    );
  }

  if (filesystemBackend) {
    const textResult = (result) => ({
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    });
    server.registerTool(
      'list_files',
      {
        title: 'List files in an allowed directory',
        description: 'Lists one directory inside the explicitly configured filesystem roots. Does not follow symlinks. Defaults to the project directory and returns at most 500 entries.',
        inputSchema: {
          path: z.string().default('.').describe('Absolute path inside an allowed root, or a path relative to the first configured root.'),
          limit: z.number().int().min(1).max(500).default(200).describe('Maximum entries to return (1-500).'),
        },
        outputSchema: {
          path: z.string(), entries: z.array(z.object({ name: z.string(), type: z.enum(['directory', 'file', 'symlink', 'other']) })),
          truncated: z.boolean(), total_entries: z.number().int(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ path, limit }) => textResult(await filesystemBackend.listFiles(path, limit)),
    );

    server.registerTool(
      'read_file',
      {
        title: 'Read a local text file',
        description: 'Reads a UTF-8 text file inside the configured filesystem roots and returns numbered lines. Files over 5 MiB are refused; each response is capped at 64 KiB. Use start_line to read another section.',
        inputSchema: {
          path: z.string().min(1).describe('Absolute file path inside an allowed root, or relative to the first configured root.'),
          start_line: z.number().int().min(1).default(1),
          line_count: z.number().int().min(1).max(1_000).default(200),
        },
        outputSchema: {
          path: z.string(), start_line: z.number().int(), line_count: z.number().int(), total_lines: z.number().int(),
          truncated: z.boolean(), content: z.string(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ path, start_line: startLine, line_count: lineCount }) => textResult(await filesystemBackend.readFile(path, startLine, lineCount)),
    );

    server.registerTool(
      'search_files',
      {
        title: 'Search local text files',
        description: 'Searches literal text in files inside the configured roots. Skips .git, node_modules, vendor, dist, build, symlinks, binary files, and files over 1 MiB. Scans at most 2,000 files and returns at most 100 matches.',
        inputSchema: {
          query: z.string().min(1).max(500).describe('Literal text to find.'),
          path: z.string().default('.').describe('Absolute directory inside an allowed root, or relative to the first configured root.'),
          case_sensitive: z.boolean().default(false),
        },
        outputSchema: {
          query: z.string(), path: z.string(), files_visited: z.number().int(), truncated: z.boolean(),
          matches: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() })),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ query, path, case_sensitive: caseSensitive }) => textResult(await filesystemBackend.searchFiles(query, path, caseSensitive)),
    );

    server.registerTool(
      'write_file',
      {
        title: 'Create or replace a local text file',
        description: 'Creates a UTF-8 file or replaces its full contents, only within configured filesystem roots and an existing directory. Content is limited to 128 KiB. This changes host files; use only for the user’s requested edits.',
        inputSchema: {
          path: z.string().min(1),
          content: z.string().max(128 * 1024).describe('Complete UTF-8 text content, up to 128 KiB.'),
        },
        outputSchema: { path: z.string(), bytes_written: z.number().int() },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async ({ path, content }) => textResult(await filesystemBackend.writeFile(path, content)),
    );

    server.registerTool(
      'edit_file',
      {
        title: 'Replace a unique passage in a local file',
        description: 'Replaces one exact, unique passage in a UTF-8 file inside configured filesystem roots. Files and replacement text are limited to 128 KiB. If the passage is absent or appears more than once, the file is left unchanged.',
        inputSchema: {
          path: z.string().min(1),
          old_text: z.string().min(1).max(128 * 1024),
          new_text: z.string().max(128 * 1024),
        },
        outputSchema: { path: z.string(), bytes_written: z.number().int(), replacements: z.number().int() },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async ({ path, old_text: oldText, new_text: newText }) => textResult(await filesystemBackend.editFile(path, oldText, newText)),
    );
  }

  return server;
}

function consumeToolCallRateLimit(body) {
  const callCount = Array.isArray(body)
    ? body.filter((message) => message?.method === 'tools/call').length
    : Number(body?.method === 'tools/call');
  if (callCount === 0) return true;

  const now = Date.now();
  if (now - toolCallWindowStartedAt >= 60_000) {
    toolCallWindowStartedAt = now;
    toolCallsInWindow = 0;
  }
  if (toolCallsInWindow + callCount > maxToolCallsPerMinute) return false;
  toolCallsInWindow += callCount;
  return true;
}

const app = createMcpExpressApp({ host: '127.0.0.1' });
app.use((req, res, next) => {
  console.log(`HTTP ${req.method} ${req.path}`);
  res.on('finish', () => console.log(`HTTP status=${res.statusCode}`));
  next();
});
app.get('/health', (_req, res) => res.json({ ok: true, service: 'gemini-local-bash-poc', backends: enabledBackends }));

app.post(endpointPath, async (req, res) => {
  if (!consumeToolCallRateLimit(req.body)) {
    return res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32029, message: 'MCP tool call rate limit exceeded. Retry after one minute.' },
      id: Array.isArray(req.body) ? null : req.body?.id ?? null,
    });
  }

  const methods = Array.isArray(req.body)
    ? req.body.map((message) => message?.method).filter(Boolean).join(',')
    : req.body?.method;
  console.log(`MCP request method=${methods || 'unknown'}`);
  if (req.body?.method === 'tools/call') {
    const toolName = req.body.params?.name;
    const args = req.body.params?.arguments ?? {};
    if (toolName === 'run_sandbox_bash') {
      const command = args.command;
      console.log(`MCP tool=${toolName} commandBytes=${Buffer.byteLength(typeof command === 'string' ? command : '', 'utf8')} internetAccess=${args.internet_access === true}`);
    } else if (toolName === 'run_sandbox_session') {
      const commands = Array.isArray(args.commands) ? args.commands : [];
      const commandBytes = commands.reduce((total, command) => total + Buffer.byteLength(typeof command === 'string' ? command : '', 'utf8'), 0);
      console.log(`MCP tool=${toolName} commandCount=${commands.length} commandBytes=${commandBytes} lifecycle=${args.lifecycle ?? 'ephemeral'} persistent=${Boolean(args.session_id || ['conversation', 'task'].includes(args.lifecycle))} internetAccess=${args.internet_access === true}`);
    } else if (toolName === 'run_host_commands') {
      const commands = Array.isArray(args.commands) ? args.commands : [];
      const commandBytes = commands.reduce((total, command) => total + Buffer.byteLength(typeof command === 'string' ? command : '', 'utf8'), 0);
      console.log(`MCP tool=${toolName} shell=${String(args.shell ?? 'unknown')} commandCount=${commands.length} commandBytes=${commandBytes}`);
    }
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error instanceof Error ? error.message : 'unknown error');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

app.get(endpointPath, (_req, res) => res.status(405).json({ error: 'GET is not supported for this stateless endpoint.' }));
app.delete(endpointPath, (_req, res) => res.status(405).json({ error: 'This stateless endpoint has no session to delete.' }));

async function detectHostShell(shell) {
  const candidates = shell === 'bash'
    ? ['bash', 'bash.exe']
    : ['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'];
  for (const executable of candidates) {
    try {
      const args = shell === 'bash'
        ? ['--version']
        : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'];
      await execFileAsync(executable, args, { timeout: 2_000, maxBuffer: 4_096, encoding: 'utf8', windowsHide: true });
      return executable;
    } catch {
      // Try the next common executable name; the unavailable host backend is omitted.
    }
  }
  return null;
}

async function start() {
  for (const backend of requestedBackends) {
    if (backend === 'docker') {
      sandboxDockerHost = defaultSandboxDockerHost();
      await ensureSandboxBackend();
      workspaceManager = new SandboxManager({
        dbPath: stateDbPath,
        docker,
        containerArgs: sandboxContainerArgs,
        sandboxImage,
        maxWorkspaces: maxSandboxWorkspaces,
        idleTtlMs: workspaceIdleTtlMs,
        maxLifetimeMs: workspaceMaxLifetimeMs,
        lifecyclePolicies: workspaceLifecyclePolicies,
      });
      await workspaceManager.open();
      await workspaceManager.reconcile();
      enabledBackends.push('docker');
      continue;
    }
    if (backend === 'filesystem') {
      filesystemBackend = await initializeFilesystemBackend();
      enabledBackends.push('filesystem');
      continue;
    }
    const executable = await detectHostShell(backend);
    if (!executable) {
      console.warn(`Requested ${backend} backend was not detected; it will not be exposed.`);
      continue;
    }
    hostShellExecutables.set(backend, executable);
    enabledBackends.push(backend);
  }
  if (enabledBackends.length === 0) {
    throw new Error(`No requested MCP backend is available. Requested: ${requestedBackends.join(', ')}.`);
  }

  if (workspaceManager) {
    let workspaceCleanupActive = false;
    workspaceCleanupTimer = setInterval(async () => {
      if (workspaceCleanupActive) return;
      workspaceCleanupActive = true;
      try { await workspaceManager.cleanupExpired(); }
      catch (error) { console.error('Workspace cleanup failed:', error.message); }
      finally { workspaceCleanupActive = false; }
    }, 30_000);
    workspaceCleanupTimer.unref();
  }

  app.listen(port, '127.0.0.1', () => {
    console.log(`MCP PoC listening on http://127.0.0.1:${port}${endpointPath}`);
    console.log(`Detected and enabled backends: ${enabledBackends.join(', ')}.`);
    if (enabledBackends.includes('docker')) {
      console.log(`Sandbox Docker daemon: ${sandboxDockerHost} (rootless; runtime=${sandboxRuntime})`);
      console.log(`Sandbox resource policy: ${sandboxTimeoutSeconds}s per command; per-container scopes are 256 MiB memory, no swap, 0.25 CPU, 64 host tasks; the aggregate sandbox slice allows 1.5 GiB, no swap, 100% CPU, 512 tasks; the Docker service allows 768 MiB, 100% CPU, 256 tasks; max ${maxSandboxConcurrency} concurrent calls.`);
      console.log(`Workspace policy: max ${maxSandboxWorkspaces}; ephemeral workspaces are deleted after a batch; conversation TTL is ${Math.round(workspaceIdleTtlMs / 60_000)}m idle/${Math.round(workspaceMaxLifetimeMs / 60_000)}m total; task TTL is ${Math.round(taskWorkspaceIdleTtlMs / 60_000)}m idle/${Math.round(taskWorkspaceMaxLifetimeMs / 60_000)}m total; SQLite=${stateDbPath}.`);
    }
    if (hostShellExecutables.size > 0) {
      console.warn('Host shell backends execute with the MCP server user’s full local permissions. Do not expose this endpoint through an unauthenticated public tunnel.');
    }
    if (filesystemBackend) {
      console.warn(`Filesystem backend is enabled for: ${filesystemBackend.roots.join(', ')}. Gemini can read and write files in these roots; do not expose this endpoint through an unauthenticated public tunnel.`);
    }
  });
}

start().catch((error) => {
  console.error('MCP server startup refused:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
