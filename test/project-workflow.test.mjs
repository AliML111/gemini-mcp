import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadProjectProfiles, ProjectWorkflow } from '../src/project-workflow.mjs';

const execFileAsync = promisify(execFile);

async function tempDir(t) {
  const path = await mkdtemp(join(tmpdir(), 'gemini-project-workflow-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function workflow(root, profiles = new Map(), options = {}) {
  return new ProjectWorkflow({
    docker: async () => ({ stdout: '' }),
    dockerInput: async () => ({ stdout: '' }),
    profiles: profiles.size ? profiles : new Map([['demo', { id: 'demo', name: 'Demo', root, commands: {}, preview: null }]]),
    ...options,
  });
}

test('project reviews are visible and usable only by their owner', async (t) => {
  const manager = workflow(await tempDir(t));
  const { review_id: reviewId } = await manager.createReviewRun({
    project_id: 'demo', title: 'Review', plan: '', checklist: [],
  }, 'client-one');

  assert.equal((await manager.listReviewRuns('demo', 'client-one')).reviews.length, 1);
  assert.equal((await manager.listReviewRuns('demo', 'client-two')).reviews.length, 0);
  await assert.rejects(
    manager.withOwnedReview('demo', reviewId, 'client-two', () => assert.fail('unexpected review access')),
    /not available/,
  );
  assert.equal(await manager.withOwnedReview('demo', reviewId, 'client-one', () => 'allowed'), 'allowed');
});

test('project cleanup runs once when timer ticks overlap', async () => {
  const manager = workflow(tmpdir());
  let calls = 0;
  manager.cleanupExpiredSessions = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
  };
  const first = manager.runCleanup();
  const overlapping = manager.runCleanup();
  assert.equal(overlapping, first);
  await Promise.all([first, overlapping]);
  assert.equal(calls, 1);
  await manager.close();
});

async function git(root, ...args) {
  return execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
}

async function symlinkIfAvailable(target, path) {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error.code)) return false;
    throw error;
  }
}

test('project snapshots omit credentials, environment files and symlinks but keep example config', async (t) => {
  const root = await tempDir(t);
  await writeFile(join(root, 'app.js'), 'safe source\n');
  await writeFile(join(root, '.env.test'), 'FAKE_TOKEN=do-not-copy\n');
  await writeFile(join(root, '.env.example'), 'PUBLIC_SETTING=example\n');
  await mkdir(join(root, '.env'));
  await writeFile(join(root, '.env', 'config'), 'DUMMY_ENV_DIRECTORY_SECRET\n');
  await mkdir(join(root, 'credentials'));
  await writeFile(join(root, 'credentials', 'token.txt'), 'DUMMY_CREDENTIAL_DIRECTORY_SECRET\n');
  await mkdir(join(root, 'secret'));
  await writeFile(join(root, 'secret', 'key.txt'), 'DUMMY_SECRET_DIRECTORY_SECRET\n');
  await mkdir(join(root, 'docs', '.env.example'), { recursive: true });
  await writeFile(join(root, 'docs', '.env.example', 'token'), 'DUMMY_EXAMPLE_DIRECTORY_SECRET\n');
  for (const name of ['id_ecdsa', 'id_dsa', 'id_ed25519_sk', 'id_ecdsa_sk']) {
    await writeFile(join(root, name), `DUMMY_${name.toUpperCase()}_PRIVATE_KEY\n`);
  }
  await writeFile(join(root, '.npmrc'), '//registry.example/:_authToken=fake\n');
  await writeFile(join(root, 'service.pem'), 'FAKE_PRIVATE_KEY\n');
  await writeFile(join(root, 'credentials.json'), '{"token":"fake"}\n');
  const symlinkSupported = await symlinkIfAvailable(join(root, 'app.js'), join(root, 'source-link.js'));

  const instance = workflow(root);
  const snapshot = await instance.snapshotProject(root);
  try {
    const files = await readdir(snapshot.directory);
    assert.deepEqual(files.sort(), ['.env.example', 'app.js', 'docs']);
    assert.equal(await readFile(join(snapshot.directory, 'app.js'), 'utf8'), 'safe source\n');
    for (const path of [
      '.env/config', 'credentials/token.txt', 'secret/key.txt', 'docs/.env.example/token',
      'id_ecdsa', 'id_dsa', 'id_ed25519_sk', 'id_ecdsa_sk',
    ]) {
      await assert.rejects(readFile(join(snapshot.directory, path)), { code: 'ENOENT' }, `${path} should not enter the snapshot`);
    }
    assert.deepEqual(await readdir(join(snapshot.directory, 'docs')), [], 'a .env.example directory is not the example file');
    assert.equal(await readFile(join(snapshot.directory, '.env.example'), 'utf8'), 'PUBLIC_SETTING=example\n');
    if (symlinkSupported) await assert.rejects(lstat(join(snapshot.directory, 'source-link.js')), { code: 'ENOENT' });
    assert.ok(snapshot.totalEntries >= (symlinkSupported ? 16 : 15), 'directory entries, including filtered and empty directories, are counted');
  } finally {
    await rm(snapshot.directory, { recursive: true, force: true });
  }
});

test('project snapshots cap total directory entries and nesting depth', async (t) => {
  const entriesRoot = await tempDir(t);
  for (let index = 0; index < 8; index += 1) await mkdir(join(entriesRoot, `empty-${index}`));
  const entryLimited = workflow(entriesRoot, new Map(), { snapshotLimits: { maxEntries: 5 } });
  await assert.rejects(entryLimited.snapshotProject(entriesRoot), /5 total directory entries/);

  const depthRoot = await tempDir(t);
  await mkdir(join(depthRoot, 'one', 'two', 'three'), { recursive: true });
  const depthLimited = workflow(depthRoot, new Map(), { snapshotLimits: { maxDepth: 2 } });
  await assert.rejects(depthLimited.snapshotProject(depthRoot), /maximum directory depth 2/);
});

test('project network access requires an administrator-side opt-in', async (t) => {
  const root = await tempDir(t);
  const blocked = workflow(root);
  await assert.rejects(
    blocked.createProjectSession({ project_id: 'demo', internet_access: true }),
    /MCP_PROJECT_ALLOW_NETWORK=true/,
  );
  assert.equal(blocked.pendingSessions, 0);
  assert.equal(blocked.sessions.size, 0);
});

test('review diff includes regular source files and excludes secrets and untracked symlinks', async (t) => {
  const root = await tempDir(t);
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Test');
  await writeFile(join(root, 'tracked.js'), 'before\n');
  await git(root, 'add', 'tracked.js');
  await git(root, 'commit', '-qm', 'baseline');
  await writeFile(join(root, 'tracked.js'), 'after\n');
  await writeFile(join(root, 'new.js'), 'new safe file\n');
  await writeFile(join(root, '.env.test'), 'FAKE_TOKEN=must-not-appear\n');
  await writeFile(join(root, 'credentials.json'), '{"token":"must-not-appear"}\n');
  const symlinkSupported = await symlinkIfAvailable(join(root, 'new.js'), join(root, 'new-link.js'));

  const result = await workflow(root).getProjectDiff({ project_id: 'demo' });
  assert.equal(result.changed_paths, 2);
  assert.match(result.diff, /tracked\.js/);
  assert.match(result.diff, /new\.js/);
  assert.doesNotMatch(result.diff, /FAKE_TOKEN|must-not-appear|credentials\.json/);
  if (symlinkSupported) assert.doesNotMatch(result.diff, /new-link\.js/);
});

test('preview ports are validated and published only on the rootless bridge loopback', async (t) => {
  const root = await tempDir(t);
  const profiles = await loadProjectProfiles(JSON.stringify([{
    id: 'demo', root, preview: { command: 'npm run dev', port: 5173 },
  }]));
  const instance = workflow(root, profiles);
  const bridge = instance.projectContainerArgs('preview-test', { projectId: 'demo', network: 'bridge', previewPort: 5173 });
  const isolated = instance.projectContainerArgs('check-test', { projectId: 'demo', network: 'gemini-mcp-project-internal', previewPort: 5173 });
  assert.ok(bridge.includes('--publish'));
  assert.ok(bridge.includes('127.0.0.1::5173/tcp'));
  assert.equal(isolated.includes('--publish'), false);

  await assert.rejects(loadProjectProfiles(JSON.stringify([{
    id: 'low-port', root, preview: { command: 'npm run dev', port: 80 },
  }])), /port from 1024 to 65535/);
});
