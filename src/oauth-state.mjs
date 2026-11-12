import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restrictWindowsAuditFile } from './execution-audit.mjs';

export async function openOAuthState(path) {
  if (!isAbsolute(path)) throw new Error('MCP_OAUTH_STATE_DB must be an absolute path.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing && (!existing.isFile() || existing.nlink !== 1)) {
    throw new Error('OAuth state must be a regular private file.');
  }
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = await file.stat();
    if (process.platform === 'win32') await restrictWindowsAuditFile(path);
    else if (info.mode & 0o077) throw new Error('OAuth state file permissions must be private.');
  } finally {
    await file.close();
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA busy_timeout=1000;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS oauth_state (
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (scope, kind, id)
      );
      CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_state(expires_at);
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function oauthRecords(db, scope, kind) {
  const get = db.prepare('SELECT value FROM oauth_state WHERE scope=? AND kind=? AND id=? AND expires_at>?');
  const set = db.prepare('INSERT INTO oauth_state VALUES (?,?,?,?,?) ON CONFLICT(scope,kind,id) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at');
  const remove = db.prepare('DELETE FROM oauth_state WHERE scope=? AND kind=? AND id=?');
  const count = db.prepare('SELECT count(*) AS count FROM oauth_state WHERE scope=? AND kind=? AND expires_at>?');
  return {
    get(id) {
      const row = get.get(scope, kind, id, Date.now());
      if (!row) return undefined;
      const record = JSON.parse(row.value);
      if (record.resource) record.resource = new URL(record.resource);
      return record;
    },
    has(id) { return Boolean(this.get(id)); },
    get size() { return count.get(scope, kind, Date.now()).count; },
    set(id, record) { set.run(scope, kind, id, JSON.stringify(record), record.expiresAt); },
    delete(id) { remove.run(scope, kind, id); },
  };
}
