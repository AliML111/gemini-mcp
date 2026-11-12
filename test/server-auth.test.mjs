import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverScript = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('the running MCP server challenges unauthenticated MCP calls', async (t) => {
  const port = await unusedPort();
  let adminPort = await unusedPort();
  while (adminPort === port) adminPort = await unusedPort();
  const tempDir = await mkdtemp(join(tmpdir(), 'gemini-server-auth-test-'));
  const moduleConfigPath = join(tempDir, 'modules.json');
  await writeFile(moduleConfigPath, JSON.stringify({ version: 1, modules: [], skills: [] }));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const oauthPassword = 'server-auth-test-password-'.padEnd(48, 'x');
  const adminPassword = 'server-admin-test-password-'.padEnd(48, 'y');
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      MCP_BACKENDS: process.platform === 'win32' ? 'powershell' : 'bash',
      MCP_PORT: String(port),
      MCP_ADMIN_PORT: String(adminPort),
      MCP_PUBLIC_URL: 'https://mcp.example.test/mcp',
      MCP_AUTH_PASSWORD: oauthPassword,
      MCP_ADMIN_PASSWORD: adminPassword,
      MCP_MODULES_FILE: moduleConfigPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) assert.fail(`MCP server exited before listening: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) { ready = true; break; }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, `MCP server did not start: ${output}`);
  const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);

  const malformed = await fetch(`${baseUrl}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 401, 'bearer authentication runs before JSON parsing');

  const dashboardUrl = `http://127.0.0.1:${adminPort}/api/state`;
  assert.equal((await fetch(dashboardUrl, {
    headers: { Authorization: `Basic ${Buffer.from(`admin:${oauthPassword}`).toString('base64')}` },
  })).status, 401, 'OAuth approval password cannot sign in to the admin dashboard');
  assert.equal((await fetch(dashboardUrl, {
    headers: { Authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}` },
  })).status, 200, 'the separate admin password can sign in to the dashboard');
});
