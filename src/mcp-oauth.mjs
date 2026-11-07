import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  InvalidGrantError, InvalidRequestError, InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

const accessTokenTtlMs = 60 * 60 * 1000;
const refreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000;
const authorizationCodeTtlMs = 5 * 60 * 1000;
const authorizationRequestTtlMs = 10 * 60 * 1000;
const supportedScopes = ['mcp:tools'];

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

function setAuthorizationPageHeaders(res) {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

class PasswordOAuthProvider {
  constructor(password, resourceUrl) {
    this.passwordDigest = createHash('sha256').update(password, 'utf8').digest();
    this.resourceUrl = resourceUrl;
    this.clients = new Map();
    this.authorizationRequests = new Map();
    this.codes = new Map();
    this.accessTokens = new Map();
    this.refreshTokens = new Map();
    this.clientsStore = {
      getClient: async (clientId) => this.clients.get(clientId),
      registerClient: async (client) => {
        this.cleanupExpired();
        if (this.clients.size >= 200) throw new InvalidRequestError('Client registration limit reached.');
        this.clients.set(client.client_id, client);
        return client;
      },
    };
  }

  cleanupExpired(now = Date.now()) {
    for (const [key, value] of this.authorizationRequests) {
      if (value.expiresAt <= now) this.authorizationRequests.delete(key);
    }
    for (const [key, value] of this.codes) {
      if (value.expiresAt <= now) this.codes.delete(key);
    }
    for (const [key, value] of this.accessTokens) {
      if (value.expiresAt <= now) this.accessTokens.delete(key);
    }
    for (const [key, value] of this.refreshTokens) {
      if (value.expiresAt <= now) this.refreshTokens.delete(key);
    }
  }

  renderAuthorizationPage(client, params, res, message = '') {
    const csrfToken = randomBytes(32).toString('base64url');
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
    const clientName = escapeHtml(client.client_name || 'Gemini MCP client');
    const scopeLabel = escapeHtml(params.scopes.length ? params.scopes.join(', ') : 'mcp:tools');
    const error = message ? `<p role="alert">${escapeHtml(message)}</p>` : '';
    setAuthorizationPageHeaders(res);
    res.status(message ? 401 : 200).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize MCP access</title>
<style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:10vh auto;padding:0 1rem;color:#18212b}main{border:1px solid #ccd3dc;border-radius:12px;padding:1.5rem}label{display:block;margin:.8rem 0 .3rem}input{box-sizing:border-box;width:100%;padding:.7rem;font:inherit}button{margin-top:1rem;padding:.7rem 1rem;font:inherit}</style></head>
<body><main><h1>Authorize MCP access</h1><p><strong>${clientName}</strong> requests access to this MCP server.</p><p>Access includes: ${scopeLabel}</p>${error}
<form method="post" action="/authorize">${fields}<label for="password">Server access password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required><button type="submit">Authorize</button></form></main></body></html>`);
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
    const submittedPassword = typeof body.password === 'string' && Buffer.byteLength(body.password) <= 256
      ? body.password
      : '';
    const submittedDigest = createHash('sha256').update(submittedPassword, 'utf8').digest();
    if (!submittedPassword || !timingSafeEqual(submittedDigest, this.passwordDigest)) {
      this.renderAuthorizationPage(client, params, res, 'The server access password was not accepted.');
      return;
    }

    const code = randomBytes(32).toString('base64url');
    const scopes = params.scopes.length ? params.scopes : supportedScopes;
    this.codes.set(code, {
      clientId: client.client_id,
      params: { ...params, scopes },
      expiresAt: Date.now() + authorizationCodeTtlMs,
    });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', code);
    if (params.state !== undefined) redirect.searchParams.set('state', params.state);
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
    return this.issueTokens(client.client_id, code.params.scopes, this.resourceUrl);
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    this.cleanupExpired();
    const token = this.refreshTokens.get(refreshToken);
    if (!token || token.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired refresh token.');
    if (resource && !sameResource(resource.href, token.resource.href)) {
      throw new InvalidGrantError('Refresh token is bound to a different resource.');
    }
    const nextScopes = scopes?.length ? scopes : token.scopes;
    if (nextScopes.some((scope) => !token.scopes.includes(scope))) {
      throw new InvalidGrantError('Refresh token cannot grant additional scopes.');
    }
    this.refreshTokens.delete(refreshToken);
    return this.issueTokens(client.client_id, nextScopes, token.resource);
  }

  issueTokens(clientId, scopes, resource) {
    const now = Date.now();
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const accessExpiresAt = now + accessTokenTtlMs;
    const refreshExpiresAt = now + refreshTokenTtlMs;
    this.accessTokens.set(accessToken, {
      clientId, scopes, resource, expiresAt: accessExpiresAt, refreshToken,
    });
    this.refreshTokens.set(refreshToken, {
      clientId, scopes, resource, expiresAt: refreshExpiresAt,
    });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: Math.floor(accessTokenTtlMs / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token) {
    this.cleanupExpired();
    const access = this.accessTokens.get(token);
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
    const access = this.accessTokens.get(request.token);
    if (access?.clientId === client.client_id) {
      this.accessTokens.delete(request.token);
      this.refreshTokens.delete(access.refreshToken);
      return;
    }
    const refresh = this.refreshTokens.get(request.token);
    if (refresh?.clientId === client.client_id) this.refreshTokens.delete(request.token);
  }
}

export function createMcpOAuthSecurity({ publicUrl, password, endpointPath = '/mcp' }) {
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
  const provider = new PasswordOAuthProvider(password, resourceUrl);
  const issuerUrl = new URL('/', resourceUrl.origin);
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '8kb' }));
  router.use(mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: resourceUrl,
    scopesSupported: supportedScopes,
    resourceName: 'Gemini MCP tools',
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
