import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SandboxManager } from '../src/sandbox-manager.mjs';

const sandboxTest = process.platform === 'linux' ? test
  : (name, fn) => test.skip(name, { skip: 'Sandbox manager requires Linux flock(1).' }, fn);

function fakeContainer(name, labels, id = randomUUID()) {
  const labelMap = Object.fromEntries(labels.map((label) => label.split(/=(.*)/s).slice(0, 2)));
  return {
    Id: id, Name: `/${name}`, Config: { User: '10001:10001', Image: 'test-image', Labels: labelMap },
    State: { Running: true },
    HostConfig: {
      Runtime: 'runsc', NetworkMode: 'none', ReadonlyRootfs: true,
      Privileged: false, Memory: 268435456, MemorySwap: 268435456,
      NanoCpus: 250000000, PidsLimit: 64,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges=true'],
      Tmpfs: { '/workspace': 'rw,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700' },
    },
  };
}

function fakeDocker() {
  const containers = new Map();
  const calls = [];
  let failRemove = false;
  async function docker(args) {
    calls.push(args);
    const [command] = args;
    if (command === 'run') {
      const name = args[args.indexOf('--name') + 1];
      const labels = args.flatMap((value, index) => value === '--label' ? [args[index + 1]] : []);
      const container = fakeContainer(name, labels);
      if (containers.has(name)) throw new Error('container name conflict');
      containers.set(name, container);
      return { stdout: container.Id };
    }
    if (command === 'inspect') {
      const key = args.at(-1);
      const container = [...containers.values()].find((item) => item.Id === key || item.Name === `/${key}`);
      if (!container) throw Object.assign(new Error(`No such object: ${key}`), { stderr: `No such object: ${key}` });
      return { stdout: JSON.stringify([container]) };
    }
    if (command === 'ps') {
      const filter = args[args.indexOf('--filter') + 1]?.replace(/^label=/, '');
      const [key, value] = filter?.split('=') ?? [];
      return { stdout: [...containers.values()]
        .filter((item) => !key || item.Config.Labels[key] === value)
        .map((item) => item.Id).join('\n') };
    }
    if (command === 'rm') {
      if (failRemove) throw new Error('Docker temporarily unavailable');
      const key = args.at(-1);
      for (const [name, item] of containers) {
        if (item.Id === key || item.Name === `/${key}`) containers.delete(name);
      }
      return { stdout: key };
    }
    throw new Error(`Unexpected fake Docker command: ${args.join(' ')}`);
  }
  return { docker, containers, calls, setFailRemove(value) { failRemove = value; } };
}

async function fixture(t, { dockerFake = fakeDocker(), now = () => 1000, maxWorkspaces = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ax-sandbox-test-'));
  t.after(async () => rm(dir, { force: true, recursive: true }));
  const dbPath = join(dir, 'state.sqlite');
  function createManager() {
    return new SandboxManager({ dbPath, docker: dockerFake.docker,
      containerArgs: (name, labels) => ['--name', name, '--label', 'gemini-mcp-poc.managed=true',
        ...labels.flatMap((label) => ['--label', label])],
      sandboxImage: 'test-image', now, maxWorkspaces,
      idleTtlMs: 60_000, maxLifetimeMs: 180_000 });
  }
  const manager = createManager();
  await manager.open();
  t.after(() => manager.close());
  return { manager, createManager, dockerFake, dbPath };
}

sandboxTest('creates, lists, executes and deletes a SQLite-backed sandbox', async (t) => {
  const { manager, dockerFake } = await fixture(t);
  const id = await manager.create();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(manager.list()[0].state, 'ready');
  assert.equal(manager.inspect(id).workspace_id, id);
  let name;
  assert.equal(await manager.execute(id, async (workspaceName) => {
    name = workspaceName;
    assert.equal(manager.inspect(id).state, 'busy');
    return 'ok';
  }), 'ok');
  assert.equal(name, `gemini-mcp-ws-${id}`);
  assert.equal(manager.inspect(id).state, 'ready');
  assert.equal(await manager.remove(id), true);
  assert.deepEqual(manager.list(), []);
  assert.equal(dockerFake.containers.size, 0);
});

sandboxTest('reconcile keeps active workspaces across server restart', async (t) => {
  const { manager, createManager, dockerFake } = await fixture(t);
  const id = await manager.create();
  await manager.close();
  const recovered = createManager();
  await recovered.open();
  t.after(() => recovered.close());
  await recovered.reconcile();
  assert.equal(recovered.inspect(id).state, 'ready');
  assert.equal(dockerFake.containers.size, 1);
  await recovered.remove(id);
});

sandboxTest('reconcile deletes interrupted busy workspace rather than trusting it', async (t) => {
  const { manager, createManager, dockerFake } = await fixture(t);
  const id = await manager.create();
  manager.db.prepare("UPDATE workspaces SET state='busy' WHERE id=?").run(id);
  await manager.close();
  const restarted = createManager();
  await restarted.open();
  t.after(() => restarted.close());
  await restarted.reconcile();
  assert.deepEqual(restarted.list(), []);
  assert.equal(dockerFake.containers.size, 0);
});

sandboxTest('reconcile completes a crash-interrupted creation when Docker container exists', async (t) => {
  const { manager, createManager } = await fixture(t);
  const id = await manager.create();
  manager.db.prepare("UPDATE workspaces SET state='creating', container_id=NULL WHERE id=?").run(id);
  await manager.close();
  const restarted = createManager();
  await restarted.open();
  t.after(() => restarted.close());
  await restarted.reconcile();
  assert.equal(restarted.inspect(id).state, 'ready');
  assert.equal(typeof restarted.row(id).container_id, 'string');
});

sandboxTest('reconcile removes untracked containers but refuses mismatched identity', async (t) => {
  const { manager, dockerFake } = await fixture(t);
  const id = randomUUID();
  const name = `gemini-mcp-ws-${id}`;
  dockerFake.containers.set(name, fakeContainer(name, [
    'gemini-mcp-poc.managed=true', 'gemini-mcp-poc.workspace=true', `gemini-mcp-poc.workspace-id=${id}`,
  ]));
  await manager.reconcile();
  assert.equal(dockerFake.containers.size, 0);
  const actual = await manager.create();
  dockerFake.containers.get(`gemini-mcp-ws-${actual}`).Config.Labels['gemini-mcp-poc.workspace-id'] = 'spoofed';
  await assert.rejects(() => manager.remove(actual), /identity mismatch/);
  assert.equal(dockerFake.containers.size, 1);
});

sandboxTest('reconcile removes crashed one-shot command containers', async (t) => {
  const { manager, dockerFake } = await fixture(t);
  dockerFake.containers.set('gemini-mcp-run-1234', fakeContainer('gemini-mcp-run-1234', ['gemini-mcp-poc.managed=true']));
  await manager.reconcile();
  assert.equal(dockerFake.containers.size, 0);
});

sandboxTest('TTL expires workspaces, but not active Docker execs', async (t) => {
  let clock = 1000;
  const { manager } = await fixture(t, { now: () => clock });
  const id = await manager.create();
  clock += 61_000;
  await manager.cleanupExpired();
  assert.deepEqual(manager.list(), []);
  const next = await manager.create();
  const operation = manager.execute(next, async () => {
    clock += 61_000;
    await manager.cleanupExpired();
    assert.equal(manager.inspect(next).state, 'busy');
  });
  await operation;
  await manager.cleanupExpired();
  assert.equal(manager.inspect(next).state, 'ready'); // successful exec renews idle TTL
  clock += 61_000;
  await manager.cleanupExpired();
  assert.deepEqual(manager.list(), []);
});

sandboxTest('rejects concurrent operations or removal while workspace is busy', async (t) => {
  const { manager } = await fixture(t);
  const id = await manager.create();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = manager.execute(id, async () => gate);
  await assert.rejects(manager.execute(id, async () => {}), /already in use|missing, expired/);
  await assert.rejects(manager.remove(id), /running a command/);
  release();
  await running;
  await manager.remove(id);
});

sandboxTest('enforces workspace cap even with concurrent requests', async (t) => {
  const { manager } = await fixture(t);
  const outcomes = await Promise.allSettled([manager.create(), manager.create(), manager.create()]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 2);
  assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(manager.list().length, 2);
});

sandboxTest('failed container deletion remains tracked for retry', async (t) => {
  const { manager, dockerFake } = await fixture(t);
  const id = await manager.create();
  dockerFake.setFailRemove(true);
  await assert.rejects(manager.remove(id), /Docker temporarily unavailable/);
  assert.equal(manager.inspect(id).state, 'deleting');
  dockerFake.setFailRemove(false);
  await manager.cleanupExpired();
  assert.equal(manager.list().length, 0);
});

test('cleanup continues after one workspace fails identity verification', async () => {
  const removed = [];
  const manager = {
    maintenance: null,
    rows: () => [{ id: 'invalid', state: 'deleting' }, { id: 'valid', state: 'deleting' }],
    expired: () => false,
    deleteRow: async (row) => {
      if (row.id === 'invalid') throw new Error('container identity mismatch');
      removed.push(row.id);
    },
  };
  await assert.rejects(SandboxManager.prototype.cleanupExpired.call(manager), /identity mismatch/);
  assert.deepEqual(removed, ['valid'], 'one bad row does not block cleanup of other workspaces');
  assert.equal(manager.maintenance, null, 'cleanup lock is released even when one row fails');
});

sandboxTest('missing container and expired workspace are pruned during reconcile', async (t) => {
  const { manager, createManager, dockerFake } = await fixture(t);
  const id = await manager.create();
  dockerFake.containers.clear();
  await manager.close();
  const restarted = createManager();
  await restarted.open();
  t.after(() => restarted.close());
  await restarted.reconcile();
  assert.deepEqual(restarted.list(), []);
  assert.equal(restarted.row(id), undefined);
});


sandboxTest('refuses workspace deletion while it is still being created', async (t) => {
  const { manager } = await fixture(t);
  const id = await manager.create();
  manager.db.prepare("UPDATE workspaces SET state='creating' WHERE id=?").run(id);
  await assert.rejects(manager.remove(id), /still being created/);
  assert(manager.row(id));
});

sandboxTest('orphan cleanup fails closed for unexpected isolation settings', async (t) => {
  const { manager, dockerFake } = await fixture(t);
  const id = randomUUID();
  const name = `gemini-mcp-ws-${id}`;
  const orphan = fakeContainer(name, [
    'gemini-mcp-poc.managed=true', 'gemini-mcp-poc.workspace=true', `gemini-mcp-poc.workspace-id=${id}`,
  ]);
  orphan.HostConfig.Privileged = true;
  dockerFake.containers.set(name, orphan);
  await assert.rejects(manager.reconcile(), /unexpected Docker isolation settings/);
  assert.equal(dockerFake.containers.size, 1);
});

sandboxTest('second manager cannot take the same SQLite owner lock until first closes', async (t) => {
  const { manager, createManager } = await fixture(t);
  const contender = createManager();
  await assert.rejects(contender.open(), /already owned by another MCP process/);
  assert.equal(contender.db, null, 'loser must never open the SQLite database');
  await manager.close();
  await contender.open();
  t.after(() => contender.close());
  assert.deepEqual(contender.list(), []);
});

sandboxTest('failed database initialization releases owner lock for a retry', async (t) => {
  const { manager, createManager } = await fixture(t);
  await manager.close();
  const retry = createManager();
  await retry.open();
  t.after(() => retry.close());
  assert.deepEqual(retry.list(), []);
});

sandboxTest('kernel lock is released after abrupt owner-process death', async (t) => {
  const { manager, createManager, dbPath } = await fixture(t);
  await manager.close();
  const source = [
    "import { RegistryOwnerLock } from " + JSON.stringify(new URL('../src/registry-owner-lock.mjs', import.meta.url).href) + ";",
    "const lock = new RegistryOwnerLock(process.argv[1]);",
    "await lock.acquire();",
    "process.stdout.write('READY\\n');",
    "setInterval(() => {}, 60000);",
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, `${dbPath}.owner.lock`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('lock subprocess did not start')), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('READY\n')) { clearTimeout(timeout); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`child exited early: ${code}`)); });
  });
  const contender = createManager();
  await assert.rejects(contender.open(), /already owned by another MCP process/);
  child.kill('SIGKILL');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await contender.open();
      t.after(() => contender.close());
      assert.deepEqual(contender.list(), []);
      return;
    } catch (error) {
      if (!/already owned/.test(error.message) || attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});
