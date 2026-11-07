import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const execFileAsync = promisify(execFile);
const resourceUrl = process.env.MCP_PUBLIC_URL ? new URL(process.env.MCP_PUBLIC_URL) : null;
const endpoint = new URL(process.env.MCP_URL ?? process.env.MCP_PUBLIC_URL ?? 'http://127.0.0.1:8787/mcp');
const authPassword = process.env.MCP_AUTH_PASSWORD;
const dockerHost = process.env.SANDBOX_DOCKER_HOST
  ?? `unix://${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`}/docker.sock`;
const managedLabel = 'gemini-mcp-poc.managed=true';
const workspaceLabel = 'gemini-mcp-poc.workspace=true';
const sandboxSlice = 'app-gemini-mcp-sandbox.slice';
const sandboxRunscWrapper = fileURLToPath(new URL('../scripts/runsc-scope-wrapper.sh', import.meta.url));
const sandboxMemoryBytes = 256 * 1024 * 1024;
const sandboxTaskLimit = 64;
const sandboxNanoCpus = 250_000_000;
const sandboxResourceFlags = [
  '--memory=256m',
  '--memory-swap=256m',
  '--cpus=0.25',
  '--pids-limit=64',
];
let sandboxSliceControlGroup = '';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const client = new Client({ name: 'gemini-local-bash-mcp-smoke', version: '0.3.0' }, { capabilities: {} });

async function obtainSmokeToken() {
  if (!resourceUrl || resourceUrl.protocol !== 'https:' || !authPassword) {
    throw new Error('Set MCP_PUBLIC_URL to the server HTTPS MCP URL and MCP_AUTH_PASSWORD to its access password before running smoke checks.');
  }
  const issuerUrl = new URL('/', resourceUrl.origin);
  const metadataResponse = await fetch(new URL('/.well-known/oauth-authorization-server', issuerUrl));
  const metadataText = await metadataResponse.text();
  if (!metadataResponse.ok) throw new Error(`OAuth discovery failed (${metadataResponse.status}): ${metadataText}`);
  const metadata = JSON.parse(metadataText);
  const callbackUrl = 'https://smoke-client.example.invalid/callback';
  const registrationResponse = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Local MCP smoke test',
      redirect_uris: [callbackUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const registrationText = await registrationResponse.text();
  if (!registrationResponse.ok) throw new Error(`OAuth client registration failed (${registrationResponse.status}): ${registrationText}`);
  const registeredClient = JSON.parse(registrationText);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: registeredClient.client_id,
    redirect_uri: callbackUrl,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp:tools',
    state: randomBytes(16).toString('base64url'),
    resource: resourceUrl.href,
  });
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.search = authParams.toString();
  const authorizationPage = await fetch(authorizationUrl);
  const authorizationHtml = await authorizationPage.text();
  if (!authorizationPage.ok) throw new Error(`OAuth authorization page failed (${authorizationPage.status}): ${authorizationHtml}`);
  const csrfToken = authorizationHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  if (!csrfToken) throw new Error('OAuth authorization form did not include its CSRF token.');
  const authorizationResponse = await fetch(metadata.authorization_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({ ...Object.fromEntries(authParams), csrf_token: csrfToken, password: authPassword }),
  });
  const callback = authorizationResponse.headers.get('location');
  if (authorizationResponse.status !== 302 || !callback) {
    throw new Error(`OAuth password authorization failed (${authorizationResponse.status}): ${await authorizationResponse.text()}`);
  }
  const code = new URL(callback).searchParams.get('code');
  if (!code) throw new Error('OAuth authorization redirect did not include a code.');
  const tokenResponse = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: registeredClient.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: callbackUrl,
      resource: resourceUrl.href,
    }),
  });
  const tokenText = await tokenResponse.text();
  if (!tokenResponse.ok) throw new Error(`OAuth token exchange failed (${tokenResponse.status}): ${tokenText}`);
  return JSON.parse(tokenText).access_token;
}

const accessToken = await obtainSmokeToken();
const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
});

async function docker(args, options = {}) {
  return execFileAsync('docker', ['--host', dockerHost, ...args], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    ...options,
  });
}

function textOf(result) {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = textOf(result);
  assert.notEqual(result.isError, true, `${name} returned an MCP error: ${text}`);
  return text;
}

async function listManagedContainers(label = managedLabel) {
  const { stdout } = await docker(['ps', '-aq', '--filter', `label=${label}`]);
  return stdout.trim().split('\n').filter(Boolean);
}

async function assertPerContainerResourceLimits(container) {
  assert.equal(container.HostConfig.Memory, sandboxMemoryBytes);
  assert.equal(container.HostConfig.MemorySwap, sandboxMemoryBytes);
  assert.equal(container.HostConfig.NanoCpus, sandboxNanoCpus);
  assert.equal(container.HostConfig.PidsLimit, sandboxTaskLimit);
  assert(Number.isInteger(container.State.Pid) && container.State.Pid > 0, 'sandbox has no live host PID');

  const cgroupText = await readFile(`/proc/${container.State.Pid}/cgroup`, 'utf8');
  const cgroupPath = cgroupText.split('\n').find((line) => line.startsWith('0::'))?.slice(3);
  assert(cgroupPath?.startsWith(`${sandboxSliceControlGroup}/`),
    `gVisor process is outside the per-container slice: ${cgroupPath ?? 'missing cgroup path'}`);
  assert(cgroupPath.endsWith('.scope'), 'gVisor process does not have its own systemd scope');

  const cgroupDirectory = join('/sys/fs/cgroup', cgroupPath.replace(/^\/+/, ''));
  const [cpuLimit, memoryLimit, swapLimit, taskLimit] = await Promise.all([
    readFile(join(cgroupDirectory, 'cpu.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'memory.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'memory.swap.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'pids.max'), 'utf8'),
  ]);
  assert.equal(cpuLimit.trim(), '25000 100000');
  assert.equal(memoryLimit.trim(), String(sandboxMemoryBytes));
  assert.equal(swapLimit.trim(), '0');
  assert.equal(taskLimit.trim(), String(sandboxTaskLimit));
}

try {
  const [securityResult, runtimesResult] = await Promise.all([
    docker(['info', '--format', '{{json .SecurityOptions}}']),
    docker(['info', '--format', '{{json .Runtimes}}']),
  ]);
  const securityOptions = JSON.parse(securityResult.stdout);
  const runtimes = JSON.parse(runtimesResult.stdout);
  assert(securityOptions.includes('name=rootless'), 'sandbox daemon is not rootless');
  assert(securityOptions.some((option) => option.startsWith('name=seccomp')), 'Docker seccomp is unavailable');
  assert(Object.hasOwn(runtimes, 'runsc'), 'gVisor runtime is missing from rootless Docker');
  assert.equal(runtimes.runsc.path, sandboxRunscWrapper, 'gVisor must use the per-container systemd-scope wrapper');
  console.log('Dedicated rootless Docker and gVisor runtime: passed');

  const [controlGroupResult, sliceControlGroupResult] = await Promise.all([
    execFileAsync('systemctl', ['--user', 'show', 'docker.service', '--property=ControlGroup', '--value'],
      { encoding: 'utf8', timeout: 5_000 }),
    execFileAsync('systemctl', ['--user', 'show', sandboxSlice, '--property=ControlGroup', '--value'],
      { encoding: 'utf8', timeout: 5_000 }),
  ]);
  const controlGroup = controlGroupResult.stdout.trim();
  sandboxSliceControlGroup = sliceControlGroupResult.stdout.trim();
  assert(controlGroup.startsWith(`/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/`),
    'rootless Docker is not in the expected user systemd cgroup');
  assert(controlGroup.startsWith(`${sandboxSliceControlGroup}/`), 'rootless Docker is outside the sandbox resource slice');
  const cgroupDirectory = join('/sys/fs/cgroup', controlGroup.replace(/^\/+/, ''));
  const sliceDirectory = join('/sys/fs/cgroup', sandboxSliceControlGroup.replace(/^\/+/, ''));
  const [cpuLimit, memoryLimit, swapLimit, taskLimit] = await Promise.all([
    readFile(join(cgroupDirectory, 'cpu.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'memory.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'memory.swap.max'), 'utf8'),
    readFile(join(cgroupDirectory, 'pids.max'), 'utf8'),
  ]);
  assert.equal(cpuLimit.trim(), '100000 100000');
  assert.equal(memoryLimit.trim(), String(768 * 1024 * 1024));
  assert.equal(swapLimit.trim(), '0');
  assert.equal(taskLimit.trim(), '256');
  const [sliceCpuLimit, sliceMemoryLimit, sliceSwapLimit, sliceTaskLimit] = await Promise.all([
    readFile(join(sliceDirectory, 'cpu.max'), 'utf8'),
    readFile(join(sliceDirectory, 'memory.max'), 'utf8'),
    readFile(join(sliceDirectory, 'memory.swap.max'), 'utf8'),
    readFile(join(sliceDirectory, 'pids.max'), 'utf8'),
  ]);
  assert.equal(sliceCpuLimit.trim(), '100000 100000');
  assert.equal(sliceMemoryLimit.trim(), String(1536 * 1024 * 1024));
  assert.equal(sliceSwapLimit.trim(), '0');
  assert.equal(sliceTaskLimit.trim(), '512');
  console.log('Aggregate Docker-service and sandbox-slice resource caps: passed');

  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map(({ name }) => name);
  assert.deepEqual(names.sort(), ['run_sandbox_bash', 'run_sandbox_session']);
  console.log('Discovered MCP tools:', names.join(', '));

  const capabilities = await callTool('run_sandbox_bash', {
    command: [
      'printf "uid="; id -u',
      'printf "cwd="; pwd',
      'python3 --version',
      'git --version',
      'jq --version',
      `awk '$2 == "/" { if ($4 ~ /(^|,)ro(,|$)/) print "rootfs=read-only"; else print "rootfs=WRITABLE" }' /proc/mounts`,
      'test ! -w /etc && printf "etc=read-only\\n"',
      'test ! -S /var/run/docker.sock && printf "docker-socket=absent\\n"',
      'test ! -e /home/ali && printf "host-home=absent\\n"',
      `awk '/^CapEff:/ { if (tolower($2) ~ /^0+$/) print "capabilities=none"; else print "capabilities=present" }' /proc/self/status`,
    ].join(' && '),
  });
  assert.match(capabilities, /uid=10001/);
  assert.match(capabilities, /cwd=\/workspace/);
  assert.match(capabilities, /Python 3\.13/);
  assert.match(capabilities, /git version/);
  assert.match(capabilities, /jq-/);
  assert.match(capabilities, /rootfs=read-only/);
  assert.match(capabilities, /etc=read-only/);
  assert.match(capabilities, /docker-socket=absent/);
  assert.match(capabilities, /host-home=absent/);
  assert.match(capabilities, /capabilities=none/);
  console.log('\nSandbox command environment, filesystem, privilege, and network checks: passed');

  const networkIsolation = await callTool('run_sandbox_bash', {
    command: `python3 -c 'import socket
checks = [("ipv4", socket.AF_INET, ("1.1.1.1", 443)), ("ipv6", socket.AF_INET6, ("2606:4700:4700::1111", 443)), ("host-mcp", socket.AF_INET, ("127.0.0.1", 8787))]
for name, family, address in checks:
    sock = socket.socket(family)
    sock.settimeout(0.1)
    try:
        result = sock.connect_ex(address)
    except OSError:
        result = 1
    finally:
        sock.close()
    print(name + "=" + ("blocked" if result else "available"))'`,
  });
  assert.match(networkIsolation, /ipv4=blocked/);
  assert.match(networkIsolation, /ipv6=blocked/);
  assert.match(networkIsolation, /host-mcp=blocked/);
  console.log('\nIPv4, IPv6, and host-loopback isolation: passed');

  const ephemeralWrite = await callTool('run_sandbox_bash', {
    command: 'printf "ephemeral" > /workspace/probe.txt && cat /workspace/probe.txt',
  });
  assert.match(ephemeralWrite, /ephemeral/);
  const ephemeralRead = await callTool('run_sandbox_bash', {
    command: 'test -e /workspace/probe.txt && printf "persists" || printf "fresh-container"',
  });
  assert.match(ephemeralRead, /fresh-container/);
  console.log('\nFresh-container files are discarded between calls: passed');

  const sessionCall = client.callTool({ name: 'run_sandbox_session', arguments: {
    commands: [
      'sleep 2; printf "session-state" > /workspace/marker.txt',
      'cat /workspace/marker.txt',
    ],
  } });
  let workspaceContainerId;
  for (let attempt = 0; attempt < 40 && !workspaceContainerId; attempt++) {
    const runningIds = await listManagedContainers(workspaceLabel);
    workspaceContainerId = runningIds[0];
    if (!workspaceContainerId) await delay(100);
  }
  assert(workspaceContainerId, 'managed session container was not created');
  const { stdout: workspaceInspectJson } = await docker(['inspect', workspaceContainerId]);
  const [workspaceContainer] = JSON.parse(workspaceInspectJson);
  assert.equal(workspaceContainer.HostConfig.Runtime, 'runsc');
  assert.equal(workspaceContainer.HostConfig.ReadonlyRootfs, true);
  assert.equal(workspaceContainer.HostConfig.NetworkMode, 'none');
  assert.equal(workspaceContainer.Config.User, '10001:10001');
  await assertPerContainerResourceLimits(workspaceContainer);
  const sessionResult = await sessionCall;
  assert.notEqual(sessionResult.isError, true, `run_sandbox_session returned an MCP error: ${textOf(sessionResult)}`);
  const sessionReport = JSON.parse(textOf(sessionResult));
  assert.equal(sessionReport.session_id, null);
  assert.equal(sessionReport.session_retained, false);
  assert.equal(sessionReport.results.length, 2);
  assert.equal(sessionReport.results[0].exit_code, 0);
  assert.match(sessionReport.results[1].stdout, /session-state/);
  assert.deepEqual(await listManagedContainers(), [], 'temporary session container was not removed automatically');
  console.log('\nBatched commands share one managed workspace and clean it up automatically: passed');

  const { stdout: inspectPrelude } = await docker(['run', '--detach', '--rm', '--init', '--pull=never',
    '--name', `gemini-mcp-inspect-${Date.now()}`, `--label=${managedLabel}`, '--runtime=runsc',
    ...sandboxResourceFlags,
    '--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true', '--shm-size=8m',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,uid=10001,gid=10001,mode=1777',
    '--tmpfs=/workspace:rw,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700',
    '--workdir=/workspace', 'gemini-mcp-sandbox:0.1.0', '/bin/sh', '-c', 'sleep 10']);
  const inspectId = inspectPrelude.trim();
  assert(inspectId, 'could not start inspection container');
  try {
    const { stdout: inspectJson } = await docker(['inspect', inspectId]);
    const [container] = JSON.parse(inspectJson);
    const config = container.HostConfig;
    assert.equal(config.Runtime, 'runsc');
    assert.equal(config.NetworkMode, 'none');
    assert.equal(config.ReadonlyRootfs, true);
    assert.equal(config.Privileged, false);
    assert.deepEqual(config.CapDrop, ['ALL']);
    assert(config.SecurityOpt.includes('no-new-privileges=true'));
    assert(!config.SecurityOpt.some((value) => value.includes('seccomp=unconfined')));
    await assertPerContainerResourceLimits(container);
    assert.equal(config.ShmSize, 8 * 1024 * 1024);
    assert.deepEqual(config.Binds, null);
    assert.equal(container.Config.User, '10001:10001');
    assert(container.Mounts.every((mount) => mount.Type === 'tmpfs'), 'sandbox has a non-tmpfs mount');
  } finally {
    await docker(['rm', '--force', inspectId]).catch(() => {});
  }
  console.log('\nLive gVisor container settings, default seccomp, and per-container cgroup limits: passed');

  const outputFlood = await callTool('run_sandbox_bash', {
    command: `python3 -c 'print("x" * 80000)'`,
  });
  assert.match(outputFlood, /output truncated at 64 KiB/);
  assert.deepEqual(await listManagedContainers(), [], 'output-flood container did not clean up');
  console.log('\nOutput flood is truncated and the container is removed: passed');

  const timeoutResult = await callTool('run_sandbox_bash', { command: 'sleep 8' });
  assert.match(timeoutResult, /5-second execution limit/);
  assert.deepEqual(await listManagedContainers(), [], 'timed-out sandbox container was not removed');
  console.log('\nCommand timeout and cleanup: passed');

  const runningCall = callTool('run_sandbox_bash', { command: 'sleep 3; printf "lifecycle-ok"' });
  let containerId;
  for (let attempt = 0; attempt < 40 && !containerId; attempt += 1) {
    const runningIds = await listManagedContainers();
    containerId = runningIds[0];
    if (!containerId) await delay(100);
  }
  assert(containerId, 'sandbox container did not appear while the test command was running');
  const { stdout: inspectJson } = await docker(['inspect', containerId]);
  const [container] = JSON.parse(inspectJson);
  assert.equal(container.HostConfig.Runtime, 'runsc');
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.HostConfig.Privileged, false);
  assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
  assert(container.HostConfig.SecurityOpt.includes('no-new-privileges=true'));
  await assertPerContainerResourceLimits(container);
  assert.equal(container.HostConfig.ShmSize, 8 * 1024 * 1024);
  assert.deepEqual(container.HostConfig.Binds, null);
  assert.equal(container.Config.User, '10001:10001');
  assert(container.Mounts.every((mount) => mount.Type === 'tmpfs'), 'sandbox has a non-tmpfs mount');
  const lifecycleResult = await runningCall;
  assert.match(lifecycleResult, /lifecycle-ok/);
  assert.deepEqual(await listManagedContainers(), [], 'completed sandbox container was not removed');
  console.log('\nLive runtime configuration and automatic cleanup: passed');

  const concurrent = await Promise.all([
    client.callTool({ name: 'run_sandbox_bash', arguments: { command: 'sleep 2; printf "parallel-a"' } }),
    client.callTool({ name: 'run_sandbox_bash', arguments: { command: 'sleep 2; printf "parallel-b"' } }),
    client.callTool({ name: 'run_sandbox_bash', arguments: { command: 'sleep 2; printf "parallel-c"' } }),
  ]);
  assert(concurrent.some((result) => result.isError && textOf(result).includes('at capacity')),
    'sandbox concurrency limit did not reject an excess request');
  assert.deepEqual(await listManagedContainers(), [], 'parallel sandbox containers were not cleaned up');
  console.log('\nConcurrent-run limit and cleanup: passed');
} finally {
  await client.close();
}
