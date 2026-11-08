import test from 'node:test';
import assert from 'node:assert/strict';
import { deniedToolCall, toolCapabilities } from '../src/tool-capabilities.mjs';

const tool = (name, args = {}) => ({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
});

test('all registered MCP tools have a declared capability', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const names = [...source.matchAll(/server\\.registerTool\\(\\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(names.length >= 20);
  assert.deepEqual(names.filter((name) => !toolCapabilities[name]), []);
  assert.deepEqual(Object.keys(toolCapabilities).filter((name) => !names.includes(name)), []);
});

test('sandbox commands require explicit execution grant', () => {
  assert.deepEqual(deniedToolCall(tool('run_sandbox_bash', { command: 'date' }), []),
    { tool: 'run_sandbox_bash', capability: 'sandbox:execute' });
  assert.equal(deniedToolCall(tool('run_sandbox_bash', { command: 'date' }), ['sandbox:execute']), null);
});

test('network permission is independent from sandbox execution', () => {
  assert.deepEqual(deniedToolCall(tool('run_sandbox_session', { commands: ['date'], internet_access: true }), ['sandbox:execute']),
    { tool: 'run_sandbox_session', capability: 'sandbox:network' });
  assert.equal(deniedToolCall(tool('run_sandbox_bash', { command: 'date', internet_access: true }),
    ['sandbox:execute', 'sandbox:network']), null);
});

test('host, filesystem write, and project network access each need separate authorization', () => {
  assert.equal(deniedToolCall(tool('read_file'), ['filesystem:read']), null);
  assert.deepEqual(deniedToolCall(tool('write_file'), ['filesystem:read']),
    { tool: 'write_file', capability: 'filesystem:write' });
  assert.deepEqual(deniedToolCall(tool('run_host_commands'), ['sandbox:execute']),
    { tool: 'run_host_commands', capability: 'host:execute' });
  assert.deepEqual(deniedToolCall(tool('start_project_session', { internet_access: true }), ['project:execute']),
    { tool: 'start_project_session', capability: 'project:network' });
});

test('a JSON-RPC batch denies if any call exceeds its grants', () => {
  assert.deepEqual(deniedToolCall([tool('read_file'), tool('edit_file')], ['filesystem:read']),
    { tool: 'edit_file', capability: 'filesystem:write' });
  assert.equal(deniedToolCall([{ method: 'tools/list' }, tool('read_file')], ['filesystem:read']), null);
});
