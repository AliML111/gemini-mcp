import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpModuleManager } from '../src/mcp-module-manager.mjs';

test('MCP tool discovery has a timeout and closes the stalled subprocess', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-module-timeout-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'modules.json');
  const childSource = [
    "const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
    "let pending = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  pending += chunk;",
    "  for (let index = pending.indexOf('\\n'); index >= 0; index = pending.indexOf('\\n')) {",
    "    const line = pending.slice(0, index); pending = pending.slice(index + 1);",
    "    if (!line) continue;",
    "    const request = JSON.parse(line);",
    "    if (request.method === 'initialize') {",
    "      write({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stall', version: '1' } } });",
    "    }",
    "  }",
    "});",
  ].join('\n');
  await writeFile(configPath, JSON.stringify({ version: 1, modules: [{
    id: 'stalled', name: 'Stalled test module', command: process.execPath,
    args: ['--input-type=module', '-e', childSource], env: {}, platforms: ['all'], enabled: true,
    capabilities: {}, toolPolicies: {},
  }], skills: [] }));

  const manager = new McpModuleManager({ configPath, discoveryTimeoutMs: 100 });
  t.after(() => manager.close());
  const started = Date.now();
  await manager.load();
  const state = manager.snapshot().modules[0];
  assert.equal(state.state, 'error');
  assert.match(state.error, /tool discovery timed out after 100 ms/);
  assert.ok(Date.now() - started < 2_000, 'discovery timeout should not stall module activation');
});

test('a timed out MCP tool call closes and disables that module', async (t) => {
  const manager = new McpModuleManager({ toolCallTimeoutMs: 25 });
  t.after(() => manager.close());
  let closed = false;
  const active = {
    module: {
      toolPolicies: { run: { enabled: true, capability: 'desktop:interact' } },
      capabilities: { 'desktop:interact': { label: 'Interact' } },
    },
    tools: [{ name: 'run' }],
    client: {
      callTool: () => new Promise(() => {}),
      close: async () => { closed = true; },
    },
  };
  manager.activeModules.set('desktop', active);
  manager.moduleStatuses.set('desktop', { id: 'desktop', state: 'connected', error: '', tools: [{ name: 'run' }] });
  manager.exposedTools = [{ moduleId: 'desktop', name: 'mcp_desktop_run' }];

  await assert.rejects(manager.callTool('desktop', 'run', {}), /timed out after 25 ms/);
  assert.equal(closed, true);
  assert.equal(manager.activeModules.has('desktop'), false);
  assert.deepEqual(manager.exposedTools, []);
  assert.equal(manager.moduleStatuses.get('desktop').state, 'error');
  assert.deepEqual(manager.moduleStatuses.get('desktop').tools, []);
});

test('MCP module configuration saves are serialized', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-module-save-queue-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = new McpModuleManager({ configPath: join(dir, 'modules.json') });
  t.after(() => manager.close());
  manager.config = { version: 1, modules: [], skills: [] };
  const events = [];
  manager.persist = async (config) => {
    events.push(`start:${config.skills[0].name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push(`end:${config.skills[0].name}`);
  };
  manager.activateModules = async () => {};
  const input = (name) => ({ version: 1, modules: [], skills: [{
    id: name.toLowerCase(), name, description: '', enabled: false, platforms: ['all'], content: 'guidance',
  }] });

  await Promise.all([manager.saveAndApply(input('First')), manager.saveAndApply(input('Second'))]);
  assert.deepEqual(events, ['start:First', 'end:First', 'start:Second', 'end:Second']);
  assert.equal(manager.config.skills[0].name, 'Second');
});
