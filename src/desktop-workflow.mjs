import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export const desktopPrefix = 'mcp_windows-desktop_';
const target = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  automation_id: z.string().min(1).max(200).optional(),
  control_type: z.string().min(1).max(60).optional(),
}).refine((value) => Boolean(value.name) !== Boolean(value.automation_id), 'Specify one exact name or automation_id.');

const action = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('click'), target }),
  z.strictObject({ kind: z.literal('invoke'), target }),
  z.strictObject({ kind: z.literal('set_value'), target, value: z.string().max(4_000) }),
  z.strictObject({ kind: z.literal('shortcut'), key: z.enum(['tab', 'shift+tab', 'enter', 'esc']) }),
]);

const expectation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('element_text'), text: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal('window_title'), title: z.string().min(1).max(300) }),
]);

export const desktopStepSchema = z.strictObject({ action, expect: expectation.optional() });
export const desktopWindowSchema = {
  window_title: z.string().min(1).max(300).describe('Exact foreground window title from Snapshot.'),
  window_pid: z.number().int().positive().optional().describe('Expected process ID from Snapshot, when known.'),
};

function actionRequest(action) {
  if (action.kind === 'shortcut') return ['Shortcut', { shortcut: action.key }];
  const selector = { ...action.target, occurrence: 'unique' };
  if (action.kind === 'click') return ['Click', selector];
  return ['Invoke', { ...selector, action: action.kind, ...(action.kind === 'set_value' && { value: action.value }) }];
}

function parseSnapshot(result) {
  const text = result.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n') ?? '';
  const [header, elements = ''] = text.split(/^Interactive elements:/m, 2);
  const focused = /^  - "([^\r\n]*)" \[pid (\d+)\] \*focused\*$/m.exec(header.replaceAll('\r\n', '\n'));
  return {
    title: focused?.[1] ?? null,
    pid: focused ? Number(focused[2]) : null,
    elements,
    text,
  };
}

export class DesktopWorkflow {
  #busy = false;

  async exclusive(action) {
    if (this.#busy) throw new Error('The Windows desktop is busy. Retry after the active desktop call finishes.');
    this.#busy = true;
    try {
      return await action();
    } finally {
      this.#busy = false;
    }
  }

  async run({ window_title: title, window_pid: pid, steps }, allowedTools, manager) {
    const requests = steps.map(({ action }) => actionRequest(action));
    const required = ['Snapshot', ...requests.map(([name]) => name)];
    if (!manager || required.some((name) => !allowedTools.has(desktopPrefix + name))) {
      throw new Error('Enable and approve Snapshot and every desktop action needed by this workflow.');
    }
    const invoke = async (name, args = {}) => {
      const result = await manager.callTool('windows-desktop', name, args);
      if (result.isError) throw new Error(result.content?.find((block) => block.type === 'text')?.text?.slice(0, 500) ?? `${name} failed.`);
      return result;
    };
    return this.exclusive(async () => {
      let snapshot;
      let completed = 0;
      let actionAttempted = false;
      const report = (reason) => {
        const details = {
          completed_steps: completed,
          ...(reason && { stopped_at_step: completed + 1, reason, action_attempted: actionAttempted }),
          snapshot: snapshot?.text.slice(0, 16_000) ?? null,
        };
        return { ...(reason && { isError: true }), content: [{ type: 'text', text: JSON.stringify(details) }], structuredContent: details };
      };
      try {
        snapshot = parseSnapshot(await invoke('Snapshot'));
        for (const [index, [name, args]] of requests.entries()) {
          actionAttempted = false;
          if (snapshot.title !== title || (pid !== undefined && snapshot.pid !== pid)) {
            return report('The requested window is not in the foreground.');
          }
          actionAttempted = true;
          await invoke(name, args);
          const expected = steps[index].expect;
          const deadline = Date.now() + 3_000;
          while (true) {
            snapshot = parseSnapshot(await invoke('Snapshot'));
            if (expected?.kind === 'window_title') {
              if (snapshot.title === expected.title) break;
            } else {
              if (snapshot.title !== title || (pid !== undefined && snapshot.pid !== pid)) {
                return report('The foreground window changed unexpectedly.');
              }
              if (!expected || snapshot.elements.includes(expected.text)) break;
            }
            if (Date.now() >= deadline) return report('The expected desktop state did not appear. Inspect the snapshot before retrying.');
            await delay(200);
          }
          completed += 1;
        }
        return report();
      } catch (error) {
        try { snapshot = parseSnapshot(await invoke('Snapshot')); } catch { /* Keep the last known snapshot. */ }
        return report(error instanceof Error ? error.message : 'Desktop action failed.');
      }
    });
  }
}
