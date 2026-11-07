import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
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
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      MCP_BACKENDS: 'bash',
      MCP_PORT: String(port),
      MCP_PUBLIC_URL: 'https://mcp.example.test/mcp',
      MCP_AUTH_PASSWORD: 'server-auth-test-password-'.padEnd(48, 'x'),
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
});
