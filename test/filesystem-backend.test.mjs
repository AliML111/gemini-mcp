import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeFilesystemBackend } from '../src/filesystem-backend.mjs';

test('filesystem roots must be explicit and cannot overlap the application directory', async () => {
  await assert.rejects(initializeFilesystemBackend(''), /MCP_FILESYSTEM_ROOTS must explicitly name/);
  const applicationRoot = fileURLToPath(new URL('../', import.meta.url));
  await assert.rejects(initializeFilesystemBackend(applicationRoot), /must not overlap the MCP application directory/);
});

test('file search caps concurrent scans and releases slots after completion or failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-filesystem-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'notes.txt'), 'needle');
  const backend = await initializeFilesystemBackend(root);
  const failed = assert.rejects(backend.searchFiles('needle', 'missing'), /does not exist/);
  const scans = Array.from({ length: 3 }, () => backend.searchFiles('needle'));
  await assert.rejects(backend.searchFiles('needle'), /at capacity/);
  await failed;
  for (const result of await Promise.all(scans)) assert.equal(result.matches.length, 1);
  assert.equal((await backend.searchFiles('needle')).matches.length, 1);
});

test('filesystem tools protect gateway state and Git internals under external roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-filesystem-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, '.gemini-mcp'));
  await mkdir(join(root, 'node_modules'));
  await Promise.all([
    writeFile(join(root, '.git', 'config'), 'git settings'),
    writeFile(join(root, '.gemini-mcp', 'modules.json'), 'private registry'),
    writeFile(join(root, 'node_modules', 'package.json'), 'installed code'),
  ]);
  const backend = await initializeFilesystemBackend(root);
  await backend.writeFile('notes.txt', 'ordinary data');
  assert.equal((await readFile(join(root, 'notes.txt'), 'utf8')), 'ordinary data');
  for (const path of ['.git/config', '.gemini-mcp/modules.json', 'node_modules/package.json']) {
    await assert.rejects(backend.readFile(path), /protected directory/);
    await assert.rejects(backend.writeFile(path, 'modified'), /protected directory/);
  }
  const listing = await backend.listFiles('.');
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['notes.txt']);
});
