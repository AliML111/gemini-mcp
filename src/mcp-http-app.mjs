import express from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { deniedToolCall } from './tool-capabilities.mjs';
import { auditMetadata, fingerprintClient, newAuditRequestId } from './execution-audit.mjs';

export function createMcpHttpApp({
  endpointPath, oauthSecurity, trustProxy, audit, rpcRateLimiter, toolCallRateLimiter,
  runtimeToolCapabilities, createServer, getProjectSessionNetworkAccess, getSandboxSessionNetworkAccess,
}) {
  const httpApp = express();
  httpApp.disable('x-powered-by');
  if (trustProxy === 'loopback') httpApp.set('trust proxy', 'loopback');
  else if (trustProxy) throw new Error('MCP_TRUST_PROXY must be unset or loopback.');
  httpApp.use(hostHeaderValidation(['127.0.0.1', 'localhost', oauthSecurity.resourceUrl.hostname]));
  httpApp.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
    next();
  });
  httpApp.use(oauthSecurity.router);
  httpApp.get('/health', (_req, res) => res.json({
    ok: true,
    service: 'gemini-local-bash-poc',
  }));

  httpApp.use(endpointPath, oauthSecurity.requireAuthentication);
  httpApp.post(endpointPath, express.json({ limit: '100kb', inflate: false }), async (req, res) => {
    const clientId = req.auth.clientId;
    if (Array.isArray(req.body) && req.body.length > 10) {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'MCP batches may contain at most 10 messages.' }, id: null });
    }
    if (!rpcRateLimiter.consume(req.body, clientId)) {
      return res.status(429).set('Retry-After', '60').json({ jsonrpc: '2.0', error: { code: -32029, message: 'MCP request rate limit exceeded.' }, id: null });
    }
    const capabilities = oauthSecurity.provider.capabilitiesForToken(req.auth.token);
    const currentToolCapabilities = runtimeToolCapabilities();
    if (!toolCallRateLimiter.consume(req.body, clientId ?? req.ip ?? 'anonymous')) {
      return res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32029, message: 'MCP tool call rate limit exceeded. Retry after one minute.' },
        id: Array.isArray(req.body) ? null : req.body?.id ?? null,
      });
    }
    const denied = deniedToolCall(req.body, capabilities, currentToolCapabilities, {
      getProjectSessionNetworkAccess: (id) => getProjectSessionNetworkAccess(id, clientId),
      getSandboxSessionNetworkAccess: (id) => getSandboxSessionNetworkAccess(id, clientId),
    });
    if (denied) {
      console.warn(`MCP denied missingCapability=${denied.capability}`);
      try {
        await audit.record({
          ...auditMetadata(denied.tool),
          event: 'tool.denied', outcome: 'denied',
          capability: denied.capability, http_status: 403,
          client_fingerprint: fingerprintClient(clientId),
          request_id: newAuditRequestId(),
        });
      } catch (error) {
        console.error('Audit write failure; denying request:', error.message);
        return res.status(503).json({ error: 'Execution auditing is unavailable; request refused.' });
      }
      return res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32003, message: `MCP client is not authorized for capability ${denied.capability}. Reauthorize and explicitly approve this capability.` },
        id: Array.isArray(req.body) ? null : req.body?.id ?? null,
      });
    }

    const grantedCapabilities = new Set(capabilities);
    const visibleTools = new Map([...currentToolCapabilities].filter(([, capability]) => grantedCapabilities.has(capability)));
    const server = createServer({
      clientId,
      clientFingerprint: fingerprintClient(clientId),
      requestId: newAuditRequestId(),
    }, visibleTools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed:', error instanceof Error ? error.message : 'unknown error');
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy();
      } else {
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

  httpApp.get(endpointPath, (_req, res) => res.status(405).json({ error: 'GET is not supported for this stateless endpoint.' }));
  httpApp.delete(endpointPath, (_req, res) => res.status(405).json({ error: 'This stateless endpoint has no session to delete.' }));
  httpApp.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = [400, 413, 415].includes(error.status) ? error.status : 500;
    const message = status === 500 ? 'Internal server error' : 'Invalid or unsupported request body.';
    if (status === 500) console.error('MCP HTTP middleware failed:', error.name);
    res.status(status).json({ jsonrpc: '2.0', error: { code: status === 500 ? -32603 : -32600, message }, id: null });
  });
  return httpApp;
}
