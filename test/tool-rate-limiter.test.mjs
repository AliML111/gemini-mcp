import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallRateLimiter } from '../src/tool-rate-limiter.mjs';

test('the general MCP budget counts discovery and batch messages', () => {
  const limiter = new ToolCallRateLimiter({ limit: 2, countAll: true });
  const discovery = { method: 'tools/list' };
  assert.equal(limiter.consume([discovery, discovery], 'client'), true);
  assert.equal(limiter.consume(discovery, 'client'), false);
  assert.equal(limiter.consume(discovery, 'other-client'), true);
});

test('tool call limits are isolated by OAuth client', () => {
  let now = 1_000;
  const limiter = new ToolCallRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
  const call = { method: 'tools/call' };
  assert.equal(limiter.consume(call, 'client-a'), true);
  assert.equal(limiter.consume(call, 'client-a'), true);
  assert.equal(limiter.consume(call, 'client-a'), false);
  assert.equal(limiter.consume(call, 'client-b'), true);
  now += 60_000;
  assert.equal(limiter.consume(call, 'client-a'), true);
});

test('JSON-RPC batches consume their tool call count for one client', () => {
  const limiter = new ToolCallRateLimiter({ limit: 2 });
  assert.equal(limiter.consume([
    { method: 'tools/list' }, { method: 'tools/call' }, { method: 'tools/call' },
  ], 'client-a'), true);
  assert.equal(limiter.consume({ method: 'tools/call' }, 'client-a'), false);
  assert.equal(limiter.consume({ method: 'tools/list' }, 'client-a'), true);
});

test('rate limiter bounds the number of live client buckets', () => {
  const limiter = new ToolCallRateLimiter({ limit: 1, maxBuckets: 1, now: () => 0 });
  assert.equal(limiter.consume({ method: 'tools/call' }, 'client-a'), true);
  assert.equal(limiter.consume({ method: 'tools/call' }, 'client-b'), false);
});
