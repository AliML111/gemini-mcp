import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { createMcpOAuthSecurity } from '../src/mcp-oauth.mjs';

const resourceUrl = 'https://mcp.example.test/mcp';
const accessPassword = 'test-password-'.padEnd(32, 'x');

async function startTestServer(t) {
  const security = createMcpOAuthSecurity({ publicUrl: resourceUrl, password: accessPassword });
  const app = express();
  app.use(security.router);
  app.post('/mcp', security.requireAuthentication, (req, res) => res.json({ client_id: req.auth.clientId }));
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
  return { baseUrl: `http://127.0.0.1:${listener.address().port}`, security };
}

async function registerClient(baseUrl) {
  const response = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Gemini OAuth test client',
      redirect_uris: ['https://client.example.test/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return JSON.parse(body);
}

function readCsrf(html) {
  const match = html.match(/name="csrf_token" value="([^"]+)"/);
  assert.ok(match, 'authorization form contains its one-time CSRF token');
  return match[1];
}

test('MCP requests require an OAuth bearer token and advertise protected-resource metadata', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const unauthorized = await fetch(`${baseUrl}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate'), /resource_metadata=/);

  const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadata.status, 200);
  const body = await metadata.json();
  assert.equal(body.resource, resourceUrl);
  assert.deepEqual(body.scopes_supported, ['mcp:tools']);
  assert.deepEqual(body.authorization_servers, ['https://mcp.example.test/']);
});

test('OAuth requires the server password, PKCE, and issues a resource-bound MCP token', async (t) => {
  const { baseUrl, security } = await startTestServer(t);
  const client = await registerClient(baseUrl);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = 'https://client.example.test/callback';
  const authParams = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp:tools',
    state: 'state-value',
    resource: resourceUrl,
  };
  const authorizationUrl = new URL('/authorize', baseUrl);
  authorizationUrl.search = new URLSearchParams(authParams);
  const authorizationPage = await fetch(authorizationUrl);
  assert.equal(authorizationPage.status, 200);
  const authorizationCsp = authorizationPage.headers.get('content-security-policy');
  assert.match(authorizationCsp, /frame-ancestors 'none'/);
  assert.match(authorizationCsp, /script-src 'nonce-/);
  assert.doesNotMatch(authorizationCsp, /(?:^|;)\s*form-action(?:\s|;|$)/);
  const originalForm = await authorizationPage.text();
  assert.match(originalForm, /<form id="authorize-form" method="post" action="\/authorize">/);
  assert.match(originalForm, /button\.disabled = true/);
  const firstCsrfToken = readCsrf(originalForm);

  const submitAuthorization = (csrfToken, password, capabilities = ['sandbox:execute']) => {
    const body = new URLSearchParams({ ...authParams, csrf_token: csrfToken, password });
    for (const capability of capabilities) body.append('capabilities', capability);
    return fetch(`${baseUrl}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body,
    });
  };
  const forgedAuthorization = await submitAuthorization('forged-csrf-token', accessPassword);
  assert.equal(forgedAuthorization.status, 400, 'authorization cannot be submitted without its issued CSRF token');
  const rejectedPassword = await submitAuthorization(firstCsrfToken, 'wrong-password');
  assert.equal(rejectedPassword.status, 401);
  const retryPage = await rejectedPassword.text();
  assert.match(retryPage, /password was not accepted/i);
  const accepted = await submitAuthorization(readCsrf(retryPage), accessPassword);
  assert.equal(accepted.status, 302);
  const acceptedAgain = await submitAuthorization(readCsrf(retryPage), accessPassword);
  assert.equal(acceptedAgain.status, 302, 'a duplicate submission of the same successful authorization is idempotent');
  assert.equal(acceptedAgain.headers.get('location'), accepted.headers.get('location'));
  const alteredReplay = await submitAuthorization(readCsrf(retryPage), accessPassword, []);
  assert.equal(alteredReplay.status, 400, 'a replay with changed capabilities is rejected');
  const callback = new URL(accepted.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('state'), 'state-value');
  const code = callback.searchParams.get('code');
  assert.ok(code);

  const tokenRequest = (codeVerifier) => fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      resource: resourceUrl,
    }),
  });
  const wrongVerifier = await tokenRequest('wrong-pkce-verifier');
  assert.equal(wrongVerifier.status, 400, 'the authorization code requires its original PKCE verifier');

  const tokenResponse = await tokenRequest(verifier);
  const tokenBody = await tokenResponse.text();
  assert.equal(tokenResponse.status, 200, tokenBody);
  const tokens = JSON.parse(tokenBody);
  assert.equal(tokens.token_type, 'bearer');
  assert.equal(tokens.scope, 'mcp:tools');
  assert.deepEqual(security.provider.capabilitiesForToken(tokens.access_token), ['sandbox:execute']);
  assert.equal(security.provider.capabilitiesForToken('invalid-token').length, 0);
  const completedReplay = await submitAuthorization(readCsrf(retryPage), accessPassword);
  assert.equal(completedReplay.status, 200, 'a duplicate submission after token exchange does not show an expired-form error');
  assert.match(await completedReplay.text(), /already completed/i);

  const authorized = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}` },
    body: '{}',
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { client_id: client.client_id });

  const tokenRecord = security.provider.accessTokens.get(tokens.access_token);
  tokenRecord.resource = new URL('https://other.example.test/mcp');
  const wrongResource = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}` },
    body: '{}',
  });
  assert.equal(wrongResource.status, 401, 'a valid token issued for a different MCP resource is rejected');

  const refreshedResponse = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource: resourceUrl,
    }),
  });
  const refreshedBody = await refreshedResponse.text();
  assert.equal(refreshedResponse.status, 200, refreshedBody);
  const refreshed = JSON.parse(refreshedBody);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token, 'refresh tokens rotate on use');
  assert.deepEqual(security.provider.capabilitiesForToken(refreshed.access_token), ['sandbox:execute'],
    'refresh must retain the original granted capabilities, never broaden them');
});

test('OAuth configuration rejects insecure or mismatched public MCP URLs and weak passwords', () => {
  assert.throws(() => createMcpOAuthSecurity({ publicUrl: 'http://mcp.example.test/mcp', password: accessPassword }), /HTTPS/);
  assert.throws(() => createMcpOAuthSecurity({ publicUrl: 'https://mcp.example.test/other', password: accessPassword }), /MCP_PATH/);
  assert.throws(() => createMcpOAuthSecurity({ publicUrl: resourceUrl, password: 'too-short' }), /32 UTF-8 bytes/);
});

test('dynamic client registration is rate-limited to prevent unbounded registration', async (t) => {
  const { baseUrl } = await startTestServer(t);
  for (let i = 0; i < 10; i += 1) {
    await registerClient(baseUrl);
  }
  const denied = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Registration flood',
      redirect_uris: ['https://client.example.test/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.ok(denied.status >= 400 && denied.status < 500, 'registration flood must be rejected');
});
