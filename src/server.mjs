import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
const workspaceLabel = 'gemini-mcp-poc.workspace=true';
const sandboxRuntime = 'runsc';
const sandboxSystemdSlice = 'app-gemini-mcp-sandbox.slice';
const sandboxRunscWrapperPath = fileURLToPath(new URL('../scripts/runsc-scope-wrapper.sh', import.meta.url));
const sandboxTimeoutSeconds = 5;
const sandboxMaxOutputBytes = 64 * 1024;
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
const maxToolCallsPerMinute = 30;
const sandboxDockerHost = process.env.SANDBOX_DOCKER_HOST
  ?? `unix://${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`}/docker.sock`;
const workspaces = new Map();
let activeSandboxRuns = 0;
let toolCallWindowStartedAt = Date.now();
let toolCallsInWindow = 0;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MCP_PORT must be a valid TCP port.');
}
if (!endpointPath.startsWith('/') || endpointPath.includes('?') || endpointPath.includes('#')) {
  throw new Error('MCP_PATH must be an absolute URL path.');
}
if (!Number.isSafeInteger(workspaceIdleTtlMs) || workspaceIdleTtlMs < 1_000
  || !Number.isSafeInteger(workspaceMaxLifetimeMs) || workspaceMaxLifetimeMs < workspaceIdleTtlMs) {
  throw new Error('Workspace TTL values must be valid milliseconds, with max lifetime >= idle TTL.');
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

async function cleanupManagedContainers() {
  const { stdout } = await docker(['ps', '-aq', '--filter', `label=${managedLabel}`]);
  const containerIds = stdout.trim().split('\n').filter(Boolean);
  if (containerIds.length) {
    await docker(['rm', '--force', ...containerIds], { timeout: 10_000 });
    console.log(`Removed ${containerIds.length} leftover sandbox container(s) from the prior MCP process.`);
  }
}

function sandboxContainerArgs(containerName, extraLabels = []) {
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
    '--network=none',
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

function sandboxResultMessage({ stdout = '', stderr = '', exitCode = 0, workspaceId = null, note = '' }) {
  const state = workspaceId
    ? `Temporary workspace ${workspaceId}; removed automatically after ${Math.round(workspaceIdleTtlMs / 60_000)} minutes idle or ${Math.round(workspaceMaxLifetimeMs / 60_000)} minutes total.`
    : 'Fresh disposable gVisor sandbox; network disabled; container removed after this call.';
  const exit = exitCode === 0 ? 'Exit code: 0' : `Exit code: ${exitCode}`;
  return `${state}\n${note}${note ? '\n' : ''}${exit}\nOutput:\n${formatSandboxOutput(stdout, stderr)}`;
}

async function removeWorkspace(workspaceId) {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) return false;
  workspaces.delete(workspaceId);
  await docker(['rm', '--force', workspace.containerName], { timeout: 3_000 }).catch(() => {});
  return true;
}

function workspaceIsExpired(workspace, now = Date.now()) {
  return now - workspace.lastUsedAt >= workspaceIdleTtlMs
    || now - workspace.createdAt >= workspaceMaxLifetimeMs;
}

async function createSandboxWorkspace() {
  if (workspaces.size >= maxSandboxWorkspaces) {
    throw new Error('All temporary workspaces are in use. Close one or wait for idle cleanup.');
  }

  const workspaceId = randomUUID();
  const containerName = `gemini-mcp-ws-${workspaceId}`;
  const labels = [workspaceLabel, `gemini-mcp-poc.workspace-id=${workspaceId}`];
  const args = [
    'run', '--detach',
    ...sandboxContainerArgs(containerName, labels),
    sandboxImage,
    '/bin/sh', '-c', 'while :; do /bin/sleep 3600; done',
  ];

  try {
    await docker(args, { timeout: 15_000 });
  } catch (error) {
    await docker(['rm', '--force', containerName], { timeout: 3_000 }).catch(() => {});
    throw new Error(`Could not create the temporary gVisor workspace. Build the sandbox with \`npm run sandbox:build\`. ${error.message}`);
  }

  const now = Date.now();
  workspaces.set(workspaceId, { containerName, createdAt: now, lastUsedAt: now });
  return workspaceId;
}

async function runSandboxBash(command, workspaceId = null) {
  if (Buffer.byteLength(command, 'utf8') > 1_000) {
    throw new Error('Sandbox command must be at most 1,000 UTF-8 bytes.');
  }
  if (activeSandboxRuns >= maxSandboxConcurrency) {
    throw new Error('Sandbox is at capacity. Retry after another run finishes.');
  }

  let containerName;
  if (workspaceId) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace || workspaceIsExpired(workspace)) {
      if (workspace) await removeWorkspace(workspaceId);
      throw new Error('That temporary workspace is missing or expired. Create a new workspace to continue.');
    }
    workspace.lastUsedAt = Date.now();
    containerName = workspace.containerName;
  } else {
    containerName = `gemini-mcp-run-${randomUUID()}`;
  }

  activeSandboxRuns += 1;
  const execution = [
    '/usr/bin/timeout', '-s', 'TERM', '-k', '1s', `${sandboxTimeoutSeconds}s`,
    '/bin/bash', '--noprofile', '--norc', '-c', command,
  ];
  const dockerArgs = workspaceId
    ? ['exec', '--user=10001:10001', '--workdir=/workspace', containerName, ...execution]
    : [
      'run', '--rm',
      ...sandboxContainerArgs(containerName),
      sandboxImage,
      ...execution,
    ];

  try {
    const result = await docker(dockerArgs, {
      timeout: 8_000,
      maxBuffer: sandboxMaxOutputBytes * 2,
    });
    return sandboxResultMessage({ stdout: result.stdout, stderr: result.stderr, workspaceId });
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    if (error.code === 124) {
      return sandboxResultMessage({
        stdout,
        stderr,
        exitCode: 124,
        workspaceId,
        note: `Command exceeded the ${sandboxTimeoutSeconds}-second execution limit.`,
      });
    }
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return sandboxResultMessage({
        stdout,
        stderr,
        exitCode: 1,
        workspaceId,
        note: `Output exceeded the ${sandboxMaxOutputBytes}-byte capture limit.`,
      });
    }
    if (Number.isInteger(error.code)) {
      return sandboxResultMessage({ stdout, stderr, exitCode: error.code, workspaceId });
    }
    if (error.killed || error.code === 'ETIMEDOUT') {
      if (workspaceId) await removeWorkspace(workspaceId);
      return sandboxResultMessage({
        stdout,
        stderr,
        exitCode: 124,
        note: 'The Docker command exceeded the 8-second outer safety limit; its workspace was discarded.',
      });
    }
    throw new Error(`Could not start the gVisor sandbox using the dedicated rootless Docker daemon. ${error.message}`);
  } finally {
    if (!workspaceId) {
      await docker(['rm', '--force', containerName], { timeout: 3_000 }).catch(() => {});
    }
    activeSandboxRuns -= 1;
  }
}

const workspaceCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [workspaceId, workspace] of workspaces) {
    if (workspaceIsExpired(workspace, now)) {
      void removeWorkspace(workspaceId);
    }
  }
}, 30_000);
workspaceCleanupTimer.unref();

function createServer() {
  const server = new McpServer(
    { name: 'gemini-local-bash-poc', version: '0.2.0' },
    {
      instructions:
        'All shell execution runs in a disposable gVisor sandbox managed by a dedicated rootless Docker daemon. Each sandbox runs in its own user-systemd scope capped at 256 MiB memory, no swap, 0.25 CPU, and 64 host tasks. The shared sandbox slice caps aggregate usage at 1.5 GiB memory, no swap, 100% of one CPU, and 512 tasks; the daemon also has a 768 MiB, one-CPU, 256-task service cap. Startup refuses to serve tools unless these cgroup values are active. Sandboxes have no network or host mounts, a read-only root, a non-root user, dropped capabilities, and no-new-privileges. Each command has a 5-second limit. run_sandbox_bash creates a fresh container by default. For multi-step work, first call create_sandbox_workspace, then pass its workspace_id to run_sandbox_bash; the workspace is temporary and automatically expires. The host-task cap limits gVisor host tasks and is not a direct guest process-count limit. Never include secrets or claim these tools can access the host.',
    },
  );

  server.registerTool(
    'create_sandbox_workspace',
    {
      title: 'Create a temporary command workspace',
      description:
        'Creates a temporary gVisor sandbox with 256 MiB memory, no swap, 0.25 CPU, and 64 host tasks, plus a private 16 MiB writable /workspace. Use its returned workspace_id on later run_sandbox_bash calls to keep files across commands. It has no network or host mounts and expires after 15 minutes idle or 60 minutes total; at most two workspaces exist at once.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const workspaceId = await createSandboxWorkspace();
      return {
        content: [{
          type: 'text',
          text: `Temporary workspace created. Use workspace_id=${workspaceId} on subsequent run_sandbox_bash calls. Files are isolated to this workspace and will be deleted automatically when it expires or is closed.`,
        }],
      };
    },
  );

  server.registerTool(
    'run_sandbox_bash',
    {
      title: 'Run Bash in an isolated gVisor sandbox',
      description:
        'Runs Bash text in a fresh disposable gVisor container. For multi-step tasks, pass the workspace_id returned by create_sandbox_workspace to reuse its isolated temporary /workspace. Every container has no network or host mounts, a read-only root filesystem, non-root UID 10001, all Linux capabilities dropped, no-new-privileges, and Docker default seccomp. Its host gVisor scope is capped at 256 MiB memory, no swap, 0.25 CPU, and 64 host tasks. The aggregate sandbox slice is capped at 1.5 GiB memory, no swap, 100% of one CPU, and 512 tasks; the Docker service has a separate 768 MiB, one-CPU, 256-task cap. Each command has a 5-second limit and output is capped at 64 KiB. The host-task cap is not a direct guest process-count limit. Do not include secrets. Changes to fresh containers disappear after each call; workspace changes persist only until that temporary workspace expires.',
      inputSchema: {
        command: z.string().trim().min(1).max(1_000).describe('Bash command text to run only inside the isolated container; maximum 1,000 UTF-8 bytes.'),
        workspace_id: z.string().uuid().optional().describe('Optional temporary workspace ID from create_sandbox_workspace. Omit to use a fresh disposable container.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ command, workspace_id: workspaceId }) => ({
      content: [{ type: 'text', text: await runSandboxBash(command, workspaceId ?? null) }],
    }),
  );

  server.registerTool(
    'close_sandbox_workspace',
    {
      title: 'Delete a temporary command workspace',
      description: 'Immediately deletes the temporary gVisor container and all files associated with the supplied workspace ID.',
      inputSchema: {
        workspace_id: z.string().uuid().describe('Temporary workspace ID returned by create_sandbox_workspace.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ workspace_id: workspaceId }) => {
      const removed = await removeWorkspace(workspaceId);
      return {
        content: [{ type: 'text', text: removed ? 'Temporary workspace deleted.' : 'Workspace already expired or was already deleted.' }],
      };
    },
  );

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
app.get('/health', (_req, res) => res.json({ ok: true, service: 'gemini-local-bash-poc' }));

app.post(endpointPath, async (req, res) => {
  if (!consumeToolCallRateLimit(req.body)) {
    return res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32029, message: 'Sandbox tool call rate limit exceeded. Retry after one minute.' },
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
      console.log(`MCP tool=${toolName} commandBytes=${Buffer.byteLength(typeof command === 'string' ? command : '', 'utf8')} persistent=${Boolean(args.workspace_id)}`);
    } else if (toolName === 'create_sandbox_workspace' || toolName === 'close_sandbox_workspace') {
      console.log(`MCP tool=${toolName}`);
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

async function start() {
  await ensureSandboxBackend();
  await cleanupManagedContainers();
  app.listen(port, '127.0.0.1', () => {
    console.log(`MCP PoC listening on http://127.0.0.1:${port}${endpointPath}`);
    console.log(`Sandbox Docker daemon: ${sandboxDockerHost} (rootless; runtime=${sandboxRuntime})`);
    console.log(`Sandbox resource policy: ${sandboxTimeoutSeconds}s per command; per-container scopes are 256 MiB memory, no swap, 0.25 CPU, 64 host tasks; the aggregate sandbox slice allows 1.5 GiB, no swap, 100% CPU, 512 tasks; the Docker service allows 768 MiB, 100% CPU, 256 tasks; max ${maxSandboxConcurrency} concurrent calls.`);
    console.log(`Workspace policy: max ${maxSandboxWorkspaces}, ${Math.round(workspaceIdleTtlMs / 60_000)}m idle TTL, ${Math.round(workspaceMaxLifetimeMs / 60_000)}m total TTL.`);
  });
}

start().catch((error) => {
  console.error('MCP server startup refused:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
