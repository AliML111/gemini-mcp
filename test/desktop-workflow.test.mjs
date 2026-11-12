import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopWorkflow, desktopPrefix } from '../src/desktop-workflow.mjs';

const allowed = new Set(['Snapshot', 'Invoke', 'Shortcut'].map((name) => desktopPrefix + name));
const snapshot = (title, text = '') => ({
  content: [{ type: 'text', text: `Foreground window: ${title}\n\nOpen windows (1):\n  - "${title}" [pid 42] *focused*\n\nInteractive elements: 1\n${text}` }],
});
const input = {
  window_title: 'Test editor',
  window_pid: 42,
  steps: [
    { action: { kind: 'set_value', target: { automation_id: 'editor' }, value: 'hello' }, expect: { kind: 'element_text', text: 'hello' } },
    { action: { kind: 'shortcut', key: 'tab' } },
  ],
};

test('desktop workflow verifies ordered actions and returns the latest snapshot', async () => {
  const calls = [];
  const manager = {
    async callTool(_id, name, args) {
      calls.push([name, args]);
      if (name === 'Snapshot') return snapshot('Test editor', calls.length > 1 ? 'hello' : '');
      return {};
    },
  };
  const result = await new DesktopWorkflow().run(input, allowed, manager);
  assert.deepEqual(calls.map(([name]) => name), ['Snapshot', 'Invoke', 'Snapshot', 'Shortcut', 'Snapshot']);
  assert.deepEqual(calls[1][1], { automation_id: 'editor', occurrence: 'unique', action: 'set_value', value: 'hello' });
  assert.equal(result.structuredContent.completed_steps, 2);
  assert.match(result.structuredContent.snapshot, /hello/);
});

test('desktop workflow checks every grant before acting and stops on a focus change', async () => {
  const runner = new DesktopWorkflow();
  const calls = [];
  const manager = {
    async callTool(_id, name) {
      calls.push(name);
      return name === 'Snapshot' ? snapshot(calls.length === 1 ? 'Test editor' : 'Other window') : {};
    },
  };
  await assert.rejects(runner.run(input, new Set([desktopPrefix + 'Snapshot', desktopPrefix + 'Invoke']), manager), /approve/);
  assert.deepEqual(calls, []);
  const result = await runner.run(input, allowed, manager);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.action_attempted, true);
  assert.match(result.structuredContent.reason, /foreground window changed/);
  assert.deepEqual(calls, ['Snapshot', 'Invoke', 'Snapshot']);
});
