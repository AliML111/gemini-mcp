import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAdminDashboard } from '../src/admin-dashboard.mjs';

async function unusedLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('admin dashboard uses a per-response CSP nonce and blocks cross-origin changes', async (t) => {
  const port = await unusedLoopbackPort();
  let reloadCount = 0;
  const manager = {
    snapshot: () => ({ platform: 'win32', config: { modules: [], skills: [] }, modules: [], capabilities: [], exposedTools: [] }),
    activate: async () => { reloadCount += 1; },
  };
  const password = 'admin-dashboard-test-password-with-sufficient-length';
  const dashboard = createAdminDashboard({ manager, password, port });
  const listener = dashboard.app.listen(port, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const origin = `http://127.0.0.1:${port}`;
  const authorization = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;

  const pageResponse = await fetch(`${origin}/`);
  const page = await pageResponse.text();
  const csp = pageResponse.headers.get('content-security-policy');
  const nonce = /<script nonce="([^"]+)"/.exec(page)?.[1];
  assert.ok(nonce, 'inline script must carry a nonce');
  assert.ok(page.includes(`<style nonce="${nonce}"`));
  assert.ok(csp.includes(`script-src 'nonce-${nonce}'`));
  assert.ok(csp.includes(`style-src 'nonce-${nonce}'`));
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(page.includes('@@CSP_NONCE@@'), false);

  const denied = await fetch(`${origin}/api/reload`, {
    method: 'POST',
    headers: { authorization, origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(denied.status, 403);
  assert.equal(reloadCount, 0);

  const malformed = await fetch(`${origin}/api/save`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get('content-type')?.includes('application/json'), true);
  assert.deepEqual(await malformed.json(), { error: 'Request body must contain valid JSON.' });

  const unauthorized = await fetch(`${origin}/api/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(unauthorized.status, 401, 'unauthenticated bodies are rejected before parsing');
});
