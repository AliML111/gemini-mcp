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

function workflow(root, profiles = new Map()) {
  return new ProjectWorkflow({
    docker: async () => ({ stdout: '' }),
    dockerInput: async () => ({ stdout: '' }),
    profiles: profiles.size ? profiles : new Map([['demo', { id: 'demo', name: 'Demo', root, commands: {}, preview: null }]]),
  });
}

async function git(root, ...args) {
  return execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
}

test('project snapshots omit credentials, environment files and symlinks but keep example config', async (t) => {
  const root = await tempDir(t);
  await writeFile(join(root, 'app.js'), 'safe source\n');
  await writeFile(join(root, '.env.test'), 'FAKE_TOKEN=do-not-copy\n');
  await writeFile(join(root, '.env.example'), 'PUBLIC_SETTING=example\n');
  await writeFile(join(root, '.npmrc'), '//registry.example/:_authToken=fake\n');
  await writeFile(join(root, 'service.pem'), 'FAKE_PRIVATE_KEY\n');
  await writeFile(join(root, 'credentials.json'), '{"token":"fake"}\n');
  await symlink(join(root, 'app.js'), join(root, 'source-link.js'));

  const instance = workflow(root);
  const snapshot = await instance.snapshotProject(root);
  try {
    const files = await readdir(snapshot.directory);
    assert.deepEqual(files.sort(), ['.env.example', 'app.js']);
    assert.equal(await readFile(join(snapshot.directory, 'app.js'), 'utf8'), 'safe source\n');
    await assert.rejects(lstat(join(snapshot.directory, 'source-link.js')), { code: 'ENOENT' });
  } finally {
    await rm(snapshot.directory, { recursive: true, force: true });
  }
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
  await symlink(join(root, 'new.js'), join(root, 'new-link.js'));

  const result = await workflow(root).getProjectDiff({ project_id: 'demo' });
  assert.equal(result.changed_paths, 2);
  assert.match(result.diff, /tracked\.js/);
  assert.match(result.diff, /new\.js/);
  assert.doesNotMatch(result.diff, /FAKE_TOKEN|must-not-appear|new-link\.js|credentials\.json/);
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
