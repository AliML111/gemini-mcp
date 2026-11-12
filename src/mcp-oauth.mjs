import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { ToolCallRateLimiter } from './tool-rate-limiter.mjs';
import { oauthRecords } from './oauth-state.mjs';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  InvalidGrantError, InvalidRequestError, InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

const googleLogo = 'data:image/png;base64,' + (await readFile(new URL('./assets/google-oauth.png', import.meta.url))).toString('base64');
const googleCallbackHosts = new Set([
  'oauth-redirect.googleusercontent.com',
  'oauth-redirect-sandbox.googleusercontent.com',
  'oauth-redirect-test.googleusercontent.com',
]);

function clientLogo(client, callback) {
  if (client.client_name === 'Google' && callback.protocol === 'https:' && googleCallbackHosts.has(callback.hostname)) {
    return { url: googleLogo, source: 'data:' };
  }
  if (!URL.canParse(client.logo_uri ?? '')) return null;
  const logo = new URL(client.logo_uri);
  if (logo.protocol !== 'https:' || logo.origin !== callback.origin || logo.username || logo.password) return null;
  return { url: logo.href, source: logo.origin };
}

const tokenKey = (value) => createHash('sha256').update(value).digest('hex');
const accessTokenTtlMs = 60 * 60 * 1000;
const refreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000;
const authorizationCodeTtlMs = 5 * 60 * 1000;
const authorizationRequestTtlMs = 10 * 60 * 1000;
const supportedScopes = ['mcp:tools'];
export const capabilityChoices = [
  { id: 'sandbox:execute', label: 'Execute isolated sandbox commands', defaultSelected: true },
  { id: 'sandbox:network', label: 'Allow sandbox internet/network access' },
  { id: 'filesystem:read', label: 'Read configured host filesystem roots' },
  { id: 'filesystem:write', label: 'Modify files inside configured host filesystem roots' },
  { id: 'project:execute', label: 'Run configured project checks and manage reviews' },
  { id: 'project:network', label: 'Allow project sessions with outbound network access' },
  { id: 'host:execute', label: 'Execute arbitrary commands directly on the host' },
];
const clientRegistrationTtlMs = 7 * 24 * 60 * 60 * 1000;
const registrationWindowMs = 15 * 60 * 1000;
const maxRegistrationsPerWindow = 10;
const consentFailureWindowMs = 15 * 60_000;
const maxConsentFailureBuckets = 10_000;

function clientIpKey(req) {
  const address = req.ip ?? req.socket.remoteAddress;
  return address ? ipKeyGenerator(address.replace(/^::ffff:(?=\d+\.)/i, '')) : 'unknown';
}

function sameResource(left, right) {
  try {
    const normalize = (value) => {
      const url = new URL(value);
      if (url.search || url.hash || url.username || url.password) return null;
      const path = url.pathname.replace(/\/$/, '') || '/';
      return `${url.origin}${path}`;
    };
    return normalize(left) !== null && normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function authorizationFormFingerprint(body) {
  const normalized = Object.entries(body ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]);
  return createHash('sha256').update(JSON.stringify(normalized)).digest();
}

function setAuthorizationPageHeaders(res, nonce, imageSource) {
  res.set({
    'Cache-Control': 'no-store',
    // Omit form-action: browsers enforce it across OAuth 302 redirect chains,
    // while this page's only form has a fixed same-origin /authorize action.
    'Content-Security-Policy': `default-src 'none'; style-src ${nonce ? `'nonce-${nonce}'` : "'none'"};${nonce ? ` script-src 'nonce-${nonce}';` : ''}${imageSource ? ` img-src ${imageSource};` : ''} base-uri 'none'; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

class PasswordOAuthProvider {
  constructor(password, resourceUrl, getCapabilityChoices, db) {
    this.passwordDigest = createHash('sha256').update(password, 'utf8').digest();
    this.resourceUrl = resourceUrl;
    this.getCapabilityChoices = getCapabilityChoices;
    this.db = db;
    const scope = tokenKey(JSON.stringify([resourceUrl.href, password]));
    const records = (kind) => db ? oauthRecords(db, scope, kind) : new Map();
    this.clients = records('client');
    this.pruneState = db?.prepare('DELETE FROM oauth_state WHERE expires_at <= ?');
    this.nextPrune = 0;
    this.clientRegistrations = new Map();
    this.consentFailures = new Map();
    this.authorizationRequests = new Map();
    this.completedAuthorizationRequests = new Map();
    this.codes = new Map();
    this.accessTokens = records('access');
    this.refreshTokens = records('refresh');
    this.clientsStore = {
      getClient: async (clientId) => {
        this.cleanupExpired();
        const record = this.clients.get(clientId);
        return record?.client;
      },
      registerClient: async (client) => {
        this.cleanupExpired();
        const now = Date.now();
        for (const value of client.redirect_uris) {
          if (!URL.canParse(value)) throw new InvalidRequestError('Invalid redirect URI.');
          const uri = new URL(value);
          const loopback = ['127.0.0.1', '[::1]'].includes(uri.hostname);
          if ((uri.protocol !== 'https:' && !(uri.protocol === 'http:' && loopback))
            || uri.username || uri.password || uri.hash) {
            throw new InvalidRequestError('Redirect URIs require HTTPS or loopback HTTP, without credentials or fragments.');
          }
        }
        if (this.clients.size >= 200) throw new InvalidRequestError('Client registration capacity reached.');
        if (this.clients.has(client.client_id)) throw new InvalidRequestError('Client ID already registered.');
        this.clients.set(client.client_id, { client, expiresAt: now + clientRegistrationTtlMs });
        if (!this.db) this.clientRegistrations.set(client.client_id, now);
        return client;
      },
    };
  }

  cleanupExpired(now = Date.now()) {
    for (const [id, createdAt] of this.clientRegistrations) {
      if (createdAt + clientRegistrationTtlMs <= now) {
        this.clients.delete(id);
        this.clientRegistrations.delete(id);
      }
    }
    for (const [key, value] of this.authorizationRequests) {
      if (value.expiresAt <= now) this.authorizationRequests.delete(key);
    }
    for (const [key, value] of this.completedAuthorizationRequests) {
      if (value.expiresAt <= now) this.completedAuthorizationRequests.delete(key);
    }
    for (const [key, value] of this.codes) {
      if (value.expiresAt <= now) this.codes.delete(key);
    }
    if (this.pruneState) {
      if (now >= this.nextPrune) {
        this.pruneState.run(now);
        this.nextPrune = now + 60_000;
      }
      return;
    }
    for (const [key, value] of this.accessTokens) {
      if (value.expiresAt <= now) this.accessTokens.delete(key);
    }
    for (const [key, value] of this.refreshTokens) {
      if (value.expiresAt <= now) this.refreshTokens.delete(key);
    }
  }

  renderAuthorizationPage(client, params, res, message = '', selectedCapabilities = null, status = message ? 401 : 200) {
    const csrfToken = randomBytes(32).toString('base64url');
    if (this.authorizationRequests.size >= 1_024) {
      this.authorizationRequests.delete(this.authorizationRequests.keys().next().value);
    }
    this.authorizationRequests.set(csrfToken, {
      clientId: client.client_id,
      params,
      expiresAt: Date.now() + authorizationRequestTtlMs,
    });
    const hiddenFields = {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      response_type: 'code',
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      ...(params.scopes.length ? { scope: params.scopes.join(' ') } : {}),
      ...(params.state !== undefined ? { state: params.state } : {}),
      ...(params.resource ? { resource: params.resource.href } : {}),
      csrf_token: csrfToken,
    };
    const fields = Object.entries(hiddenFields)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join('');
    const callback = new URL(params.redirectUri);
    const clientName = client.client_name?.trim() || callback.hostname;
    const logo = clientLogo(client, callback);
    const choices = this.getCapabilityChoices();
    const selectedIds = selectedCapabilities === null
      ? new Set(choices.filter((choice) => choice.defaultSelected).map((choice) => choice.id))
      : new Set(Array.isArray(selectedCapabilities) ? selectedCapabilities : [selectedCapabilities]);
    const capabilityCards = choices.map(({ id, label }) => `<label class="permission">
      <input type="checkbox" name="capabilities" value="${escapeHtml(id)}"${selectedIds.has(id) ? ' checked' : ''}>
      <span>${escapeHtml(label || id)}</span>
    </label>`).join('');
    const capabilitySection = capabilityCards
      ? `<fieldset class="permission-list"><legend>Allow access to</legend>${capabilityCards}</fieldset>`
      : '<div class="empty-state">No tools are available.</div>';
    const error = message ? `<div class="error-box" role="alert">${escapeHtml(message)}</div>` : '';
    const pageNonce = randomBytes(18).toString('base64url');
    setAuthorizationPageHeaders(res, pageNonce, logo?.source);
    res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Review access · Gemini MCP Gateway</title>
<style nonce="${pageNonce}">
:root{color-scheme:dark;--bg:#0d1219;--panel:#171e29;--line:#394656;--text:#f0f4fa;--muted:#aebacc;--accent:#9cd4ff}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;padding:clamp(18px,6vh,64px) 16px;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,"Segoe UI",sans-serif}
main{width:min(100%,480px);margin:auto;padding:clamp(18px,5vw,30px);border:1px solid var(--line);border-radius:16px;background:var(--panel)}
.request{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.logo{position:relative;display:grid;place-items:center;flex:0 0 44px;height:44px;border-radius:12px;background:#263648;color:var(--accent);font-weight:700}
.logo img{position:absolute;width:100%;height:100%;padding:7px;object-fit:contain;border-radius:inherit;background:#fff}
h1{margin:0;font-size:21px;overflow-wrap:anywhere}small{color:var(--muted);overflow-wrap:anywhere}
fieldset{margin:0 0 18px;padding:0;border:0;min-width:0}legend,label[for=password]{font-weight:650;margin-bottom:6px}
.permission{display:flex;align-items:center;gap:10px;padding:9px 0;cursor:pointer;border-bottom:1px solid var(--line)}
.permission input{width:17px;height:17px;margin:0;accent-color:#78bded}
label[for=password]{display:block}input[type=password],button{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);font:inherit}
input[type=password]{background:var(--bg);color:var(--text)}button{margin-top:14px;background:#24639a;color:white;font-weight:700;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.error-box{padding:10px 12px;margin-bottom:15px;border:1px solid #a65e64;border-radius:8px;color:#ffd8db}
</style></head>
<body><main>
<header class="request">
  <span class="logo" aria-hidden="true">${escapeHtml(Array.from(clientName)[0].toUpperCase())}${logo ? `<img id="client-logo" src="${escapeHtml(logo.url)}" alt="" referrerpolicy="no-referrer" hidden>` : ''}</span>
  <div><h1>Connect ${escapeHtml(clientName)}</h1><small>Returns to ${escapeHtml(callback.host)}</small></div>
</header>
${error}
<form id="authorize-form" method="post" action="/authorize">${fields}
${capabilitySection}
<label for="password">Gateway password</label>
<input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required>
<button id="authorize-button" type="submit">Approve and connect</button>
</form></main>
<script nonce="${pageNonce}">
const logo = document.getElementById('client-logo');
if (logo) {
  const reveal = () => { if (logo.naturalWidth) logo.hidden = false; };
  logo.addEventListener('load', reveal, { once: true });
  reveal();
}
document.getElementById('authorize-form').addEventListener('submit', () => {
  const button = document.getElementById('authorize-button');
  button.disabled = true;
  button.textContent = 'Connecting…';
});
</script></body></html>`);
  }

  async authorize(client, params, res) {
    this.cleanupExpired();
    if (!params.resource || !sameResource(params.resource.href, this.resourceUrl.href)) {
      throw new InvalidRequestError('The authorization request must target this MCP server resource.');
    }
    if (params.scopes.some((scope) => !supportedScopes.includes(scope))) {
      throw new InvalidRequestError('The authorization request contains an unsupported scope.');
    }
    if (res.req.method === 'GET') {
      this.renderAuthorizationPage(client, params, res);
      return;
    }
    const body = res.req.body ?? {};
    const csrfToken = typeof body.csrf_token === 'string' ? body.csrf_token : '';
    const formFingerprint = authorizationFormFingerprint(body);
    const completedRequest = this.completedAuthorizationRequests.get(csrfToken);
    if (completedRequest) {
      if (completedRequest.clientId === client.client_id
        && timingSafeEqual(completedRequest.formFingerprint, formFingerprint)) {
        if (completedRequest.codeRedeemed) {
          setAuthorizationPageHeaders(res);
          res.status(200).type('text').send('Authorization already completed. Return to Gemini.');
        } else {
          res.redirect(302, completedRequest.redirectUrl);
        }
        return;
      }
    }
    const authorizationRequest = this.authorizationRequests.get(csrfToken);
    if (!authorizationRequest || authorizationRequest.expiresAt <= Date.now()) {
      this.authorizationRequests.delete(csrfToken);
      setAuthorizationPageHeaders(res);
      res.status(400).type('text').send('Authorization form expired. Restart the connection flow.');
      return;
    }
    const expected = {
      client_id: authorizationRequest.clientId,
      redirect_uri: authorizationRequest.params.redirectUri,
      response_type: 'code',
      code_challenge: authorizationRequest.params.codeChallenge,
      code_challenge_method: 'S256',
      ...(authorizationRequest.params.scopes.length ? { scope: authorizationRequest.params.scopes.join(' ') } : {}),
      ...(authorizationRequest.params.state !== undefined ? { state: authorizationRequest.params.state } : {}),
      ...(authorizationRequest.params.resource ? { resource: authorizationRequest.params.resource.href } : {}),
    };
    if (authorizationRequest.clientId !== client.client_id
      || Object.entries(expected).some(([name, value]) => body[name] !== value)) {
      this.authorizationRequests.delete(csrfToken);
      setAuthorizationPageHeaders(res);
      res.status(400).type('text').send('Authorization request changed. Restart the connection flow.');
      return;
    }
    this.authorizationRequests.delete(csrfToken);
    const submittedCapabilities = body.capabilities === undefined ? []
      : Array.isArray(body.capabilities) ? body.capabilities : [body.capabilities];
    const capabilityIds = new Set(this.getCapabilityChoices().map((choice) => choice.id));
    if (submittedCapabilities.some((item) => typeof item !== 'string' || !capabilityIds.has(item))
      || new Set(submittedCapabilities).size !== submittedCapabilities.length) {
      setAuthorizationPageHeaders(res);
      res.status(400).type('text').send('Invalid capability selection. Restart authorization.');
      return;
    }
    const ip = clientIpKey(res.req);
    const now = Date.now();
    let failures = this.consentFailures.get(ip);
    if (failures?.expiresAt <= now) {
      this.consentFailures.delete(ip);
      failures = undefined;
    }
    if (!failures && this.consentFailures.size >= maxConsentFailureBuckets) {
      for (const [key, entry] of this.consentFailures) {
        if (entry.expiresAt <= now) this.consentFailures.delete(key);
      }
    }
    const retryMs = failures ? failures.retryAt - now
      : this.consentFailures.size >= maxConsentFailureBuckets ? 60_000 : 0;
    if (retryMs > 0) {
      const seconds = Math.ceil(retryMs / 1_000);
      res.set('Retry-After', String(seconds));
      this.renderAuthorizationPage(client, params, res, `Too many attempts. Try again in ${seconds} seconds.`, submittedCapabilities, 429);
      return;
    }
    const submittedPassword = typeof body.password === 'string' && Buffer.byteLength(body.password) <= 256
      ? body.password
      : '';
    const submittedDigest = createHash('sha256').update(submittedPassword, 'utf8').digest();
    if (!submittedPassword || !timingSafeEqual(submittedDigest, this.passwordDigest)) {
      const count = Math.min((failures?.count ?? 0) + 1, 9);
      const delayMs = count < 3 ? 0 : Math.min(60_000, 2_000 * 2 ** (count - 3));
      this.consentFailures.set(ip, { count, retryAt: now + delayMs, expiresAt: now + consentFailureWindowMs });
      this.renderAuthorizationPage(client, params, res, 'The gateway password was not accepted. Check the current password file and try again.', submittedCapabilities);
      return;
    }

    this.consentFailures.delete(ip);
    const code = randomBytes(32).toString('base64url');
    const scopes = params.scopes.length ? params.scopes : supportedScopes;
    this.codes.set(code, {
      clientId: client.client_id,
      params: { ...params, scopes },
      capabilities: submittedCapabilities,
      expiresAt: Date.now() + authorizationCodeTtlMs,
    });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', code);
    if (params.state !== undefined) redirect.searchParams.set('state', params.state);
    if (this.completedAuthorizationRequests.size >= 1_024) {
      this.completedAuthorizationRequests.delete(this.completedAuthorizationRequests.keys().next().value);
    }
    this.completedAuthorizationRequests.set(csrfToken, {
      clientId: client.client_id,
      formFingerprint,
      redirectUrl: redirect.href,
      code,
      codeRedeemed: false,
      expiresAt: Date.now() + authorizationCodeTtlMs,
    });
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    this.cleanupExpired();
    const code = this.codes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code.');
    return code.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    this.cleanupExpired();
    const code = this.codes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code.');
    if ((redirectUri && redirectUri !== code.params.redirectUri)
      || (resource && !sameResource(resource.href, this.resourceUrl.href))) {
      throw new InvalidGrantError('Authorization code does not match this redirect or resource.');
    }
    this.codes.delete(authorizationCode);
    for (const completedRequest of this.completedAuthorizationRequests.values()) {
      if (completedRequest.code === authorizationCode) completedRequest.codeRedeemed = true;
    }
    return this.issueTokens(client.client_id, code.params.scopes, this.resourceUrl, code.capabilities);
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    this.cleanupExpired();
    const refreshKey = tokenKey(refreshToken);
    const token = this.refreshTokens.get(refreshKey);
    if (!token || token.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired refresh token.');
    if (resource && !sameResource(resource.href, token.resource.href)) {
      throw new InvalidGrantError('Refresh token is bound to a different resource.');
    }
    const nextScopes = scopes?.length ? scopes : token.scopes;
    if (nextScopes.some((scope) => !token.scopes.includes(scope))) {
      throw new InvalidGrantError('Refresh token cannot grant additional scopes.');
    }
    return this.issueTokens(client.client_id, nextScopes, token.resource, token.capabilities, () => {
      if (!this.refreshTokens.has(refreshKey)) throw new InvalidGrantError('Invalid or expired refresh token.');
      this.refreshTokens.delete(refreshKey);
      this.accessTokens.delete(token.accessKey);
    });
  }

  writeState(action) {
    if (!this.db) return action();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  issueTokens(clientId, scopes, resource, capabilities = [], replace = () => {}) {
    const now = Date.now();
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const accessExpiresAt = now + accessTokenTtlMs;
    const refreshExpiresAt = now + refreshTokenTtlMs;
    const accessKey = tokenKey(accessToken);
    const refreshKey = tokenKey(refreshToken);
    this.writeState(() => {
      replace();
      this.accessTokens.set(accessKey, {
        clientId, scopes, resource, capabilities: [...capabilities], expiresAt: accessExpiresAt, refreshKey,
      });
      this.refreshTokens.set(refreshKey, {
        clientId, scopes, resource, capabilities: [...capabilities], expiresAt: refreshExpiresAt, accessKey,
      });
    });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: Math.floor(accessTokenTtlMs / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  capabilitiesForToken(token) {
    const access = this.accessTokens.get(tokenKey(token));
    return access && access.expiresAt > Date.now() ? access.capabilities : [];
  }

  async verifyAccessToken(token) {
    this.cleanupExpired();
    const access = this.accessTokens.get(tokenKey(token));
    if (!access) throw new InvalidTokenError('Invalid or expired access token.');
    return {
      token,
      clientId: access.clientId,
      scopes: access.scopes,
      expiresAt: Math.floor(access.expiresAt / 1000),
      resource: access.resource,
    };
  }

  async revokeToken(client, request) {
    const key = tokenKey(request.token);
    this.writeState(() => {
      const access = this.accessTokens.get(key);
      if (access?.clientId === client.client_id) {
        this.accessTokens.delete(key);
        this.refreshTokens.delete(access.refreshKey);
        return;
      }
      const refresh = this.refreshTokens.get(key);
      if (refresh?.clientId === client.client_id) {
        this.refreshTokens.delete(key);
        this.accessTokens.delete(refresh.accessKey);
      }
    });
  }
}

export function createMcpOAuthSecurity({ publicUrl, password, endpointPath = '/mcp', db, getCapabilityChoices = () => capabilityChoices }) {
  if (typeof publicUrl !== 'string' || typeof password !== 'string') {
    throw new Error('MCP_PUBLIC_URL and MCP_AUTH_PASSWORD are required to protect the MCP HTTP endpoint.');
  }
  let resourceUrl;
  try { resourceUrl = new URL(publicUrl); }
  catch { throw new Error('MCP_PUBLIC_URL must be an absolute HTTPS MCP endpoint URL.'); }
  if (resourceUrl.protocol !== 'https:' || resourceUrl.username || resourceUrl.password
    || resourceUrl.search || resourceUrl.hash || resourceUrl.pathname !== endpointPath) {
    throw new Error(`MCP_PUBLIC_URL must be an HTTPS URL whose path exactly matches MCP_PATH (${endpointPath}).`);
  }
  if (Buffer.byteLength(password, 'utf8') < 32) {
    throw new Error('MCP_AUTH_PASSWORD must contain at least 32 UTF-8 bytes. Generate one with: openssl rand -hex 32');
  }
  const provider = new PasswordOAuthProvider(password, resourceUrl, getCapabilityChoices, db);
  const issuerUrl = new URL('/', resourceUrl.origin);
  const router = express.Router();
  const registrationToken = process.env.MCP_REGISTRATION_TOKEN;
  if (registrationToken && Buffer.byteLength(registrationToken, 'utf8') < 32) {
    throw new Error('MCP_REGISTRATION_TOKEN must be at least 32 UTF-8 bytes.');
  }
  if (registrationToken) {
    const expected = createHash('sha256').update(`Bearer ${registrationToken}`).digest();
    router.post('/register', (req, res, next) => {
      const supplied = createHash('sha256').update(req.get('authorization') ?? '').digest();
      if (!timingSafeEqual(supplied, expected)) {
        return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'invalid_token' });
      }
      next();
    });
  }
  const registrations = new ToolCallRateLimiter({ limit: maxRegistrationsPerWindow, windowMs: registrationWindowMs, countAll: true });
  router.post('/register', (req, res, next) => {
    if (registrations.consume(null, clientIpKey(req))) return next();
    return res.status(429).set({ 'Retry-After': '900', 'Cache-Control': 'no-store' })
      .json({ error: 'slow_down', error_description: 'Registration rate limit reached. Retry later.' });
  });
  router.use(express.urlencoded({ extended: false, limit: '8kb' }));
  router.use(mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: resourceUrl,
    scopesSupported: supportedScopes,
    resourceName: 'Gemini MCP tools',
    clientRegistrationOptions: { rateLimit: false },
    authorizationOptions: { rateLimit: { windowMs: 15 * 60 * 1000, max: 20 } },
  }));
  return {
    router,
    provider,
    requireAuthentication: requireBearerAuth({
      verifier: provider,
      requiredScopes: supportedScopes,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
      expectedResource: resourceUrl.href,
    }),
    resourceUrl,
  };
}
