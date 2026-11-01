/**
 * SQLite registry for disposable, tmpfs-backed gVisor workspaces.
 *
 * This is NOT an agent orchestrator. Docker owns the containers, SQLite records
 * their temporary lifecycle, and Gemini continues to own agent decisions.
 * Only one MCP server process may own a registry at a time.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MANAGED_LABEL = 'gemini-mcp-poc.managed=true';
const WORKSPACE_LABEL = 'gemini-mcp-poc.workspace=true';
const WORKSPACE_ID_LABEL = 'gemini-mcp-poc.workspace-id';
const WORKSPACE_PREFIX = 'gemini-mcp-ws-';

function validId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
}

function validateContainer(container, row, sandboxImage = null) {
  if (!container) throw new Error(`Workspace ${row.id} has no Docker container.`);
  const labels = container.Config?.Labels ?? {};
  const name = `${WORKSPACE_PREFIX}${row.id}`;
  if (container.Name !== `/${name}`
      || labels['gemini-mcp-poc.managed'] !== 'true'
      || labels['gemini-mcp-poc.workspace'] !== 'true'
      || labels[WORKSPACE_ID_LABEL] !== row.id
      || (row.container_id && container.Id !== row.container_id)) {
    throw new Error(`Docker container identity mismatch for workspace ${row.id}; refusing to touch it.`);
  }
  const host = container.HostConfig ?? {};
  if (host.Runtime !== 'runsc' || host.NetworkMode !== 'none'
      || host.ReadonlyRootfs !== true || host.Privileged !== false
      || container.Config?.User !== '10001:10001'
      || (sandboxImage && container.Config?.Image !== sandboxImage)
      || (host.Binds != null && host.Binds.length !== 0)
      || (Array.isArray(container.Mounts) && container.Mounts.some((mount) => mount.Type !== 'tmpfs'))
      || host.Memory !== 256 * 1024 * 1024
      || host.MemorySwap !== 256 * 1024 * 1024
      || host.NanoCpus !== 250_000_000
      || host.PidsLimit !== 64
      || !Array.isArray(host.CapDrop) || !host.CapDrop.includes('ALL')
      || !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes('no-new-privileges=true')
      || !String(host.Tmpfs?.['/workspace'] ?? '').includes('size=16m')) {
    throw new Error(`Workspace ${row.id} has unexpected Docker isolation settings; refusing to use it.`);
  }
  return container;
}

export class SandboxManager {
  constructor({ dbPath, docker, containerArgs, sandboxImage, maxWorkspaces = 2,
    idleTtlMs = 15 * 60_000, maxLifetimeMs = 60 * 60_000,
    now = () => Date.now(), uuid = randomUUID } = {}) {
    if (!isAbsolute(dbPath ?? '')) throw new Error('SANDBOX_STATE_DB must be an absolute path.');
    if (typeof docker !== 'function' || typeof containerArgs !== 'function') {
      throw new Error('SandboxManager requires Docker command and container argument functions.');
    }
    this.dbPath = dbPath;
    this.docker = docker;
    this.containerArgs = containerArgs;
    this.sandboxImage = sandboxImage;
    this.maxWorkspaces = maxWorkspaces;
    this.idleTtlMs = idleTtlMs;
    this.maxLifetimeMs = maxLifetimeMs;
    this.now = now;
    this.uuid = uuid;
    this.db = null;
    this.maintenance = null;
  }

  async open() {
    await mkdir(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.dbPath, { timeout: 3000 });
    await chmod(this.dbPath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        container_name TEXT NOT NULL UNIQUE,
        container_id TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('creating','ready','busy','deleting'))
      );
    `);
  }

  close() { this.db?.close(); this.db = null; }

  row(id) { return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id); }
  rows() { return this.db.prepare('SELECT * FROM workspaces ORDER BY created_at, id').all(); }
  expired(row, now = this.now()) {
    return now - row.created_at >= this.maxLifetimeMs || now - row.last_used_at >= this.idleTtlMs;
  }

  async inspectDocker(nameOrId) {
    try {
      const { stdout } = await this.docker(['inspect', '--type', 'container', nameOrId]);
      return JSON.parse(stdout)[0] ?? null;
    } catch (error) {
      // Docker exit 1 is also used for connection failures; only treat an explicit
      // "No such" error as a missing object.
      if (/No such (object|container)/i.test(`${error.stderr ?? ''}\n${error.message ?? ''}`)) return null;
      throw error;
    }
  }

  async verify(row, { requireRunning = false } = {}) {
    const container = await this.inspectDocker(row.container_name);
    if (container) validateContainer(container, row, this.sandboxImage);
    if (requireRunning && !container?.State?.Running) {
      throw new Error(`Workspace ${row.id} container is not running.`);
    }
    return container;
  }

  async deleteRow(row) {
    // Busy workspaces must not be deleted while a command is still executing.
    if (row.state === 'busy') throw new Error('Workspace is running a command; retry after it finishes.');
    this.db.prepare("UPDATE workspaces SET state = 'deleting' WHERE id = ?").run(row.id);
    const container = await this.verify(row);
    if (container) await this.docker(['rm', '--force', container.Id], { timeout: 10_000 });
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(row.id);
  }

  async remove(id) {
    const row = this.row(id);
    if (!row) return false;
    if (row.state === 'creating') throw new Error('Workspace is still being created; retry shortly.');
    await this.deleteRow(row);
    return true;
  }

  async cleanupExpired() {
    if (this.maintenance) return this.maintenance;
    this.maintenance = (async () => {
      for (const row of this.rows()) {
        if (row.state === 'busy') continue;
        if (row.state === 'deleting' || (row.state !== 'creating' && this.expired(row))) {
          await this.deleteRow(row);
        }
      }
    })();
    try { await this.maintenance; } finally { this.maintenance = null; }
  }

  /** Called only once at startup, AFTER rootless/gVisor backend verification. */
  async reconcile() {
    // Remove leftover one-shot sandboxes from a crashed MCP process. All of
    // these have the managed label but not the workspace label.
    const { stdout: runIds } = await this.docker(['ps', '-aq', '--filter', `label=${MANAGED_LABEL}`]);
    const containerIds = runIds.trim().split('\n').filter(Boolean);
    const known = new Map(this.rows().map((row) => [row.id, row]));
    for (const containerId of containerIds) {
      const container = await this.inspectDocker(containerId);
      if (!container) continue;
      const labels = container.Config?.Labels ?? {};
      if (labels['gemini-mcp-poc.managed'] !== 'true') continue;
      if (labels['gemini-mcp-poc.workspace'] !== 'true') {
        if (!/^\/gemini-mcp-(run|resource-probe)-[0-9a-f-]+$/.test(container.Name)) {
          throw new Error(`Unexpected managed container name ${container.Name}; refusing to delete.`);
        }
        await this.docker(['rm', '--force', container.Id], { timeout: 10_000 });
        continue;
      }
      const id = labels[WORKSPACE_ID_LABEL];
      const row = known.get(id);
      if (row) validateContainer(container, row, this.sandboxImage);
      if (!row) {
        // An orphan must not consume the fixed workspace capacity forever.
        // Verify identity/isolation before deleting it; otherwise fail closed.
        if (!validId(id)) throw new Error(`Unknown managed workspace container ${container.Id} has invalid identity.`);
        validateContainer(container, { id, container_id: null }, this.sandboxImage);
        await this.docker(['rm', '--force', container.Id], { timeout: 10_000 });
      }
    }
    for (const row of this.rows()) {
      const container = await this.verify(row);
      if (row.state === 'busy' || row.state === 'deleting' || this.expired(row)
          || !container || !container.State?.Running) {
        // A process crash during exec cannot establish whether that command
        // finished. Discard the tmpfs rather than allow unsafe reuse.
        if (row.state === 'busy') this.db.prepare("UPDATE workspaces SET state='deleting' WHERE id=?").run(row.id);
        await this.deleteRow({ ...row, state: 'deleting' });
      } else if (row.state === 'creating') {
        // Docker run succeeded but the MCP process died before recording ready.
        this.db.prepare("UPDATE workspaces SET state='ready', container_id=? WHERE id=?")
          .run(container.Id, row.id);
      } else if (!row.container_id) {
        this.db.prepare('UPDATE workspaces SET container_id=? WHERE id=?').run(container.Id, row.id);
      }
    }
  }

  async create() {
    await this.cleanupExpired();
    const id = this.uuid();
    if (!validId(id)) throw new Error('UUID generator returned an invalid v4 UUID.');
    const name = `${WORKSPACE_PREFIX}${id}`;
    const now = this.now();
    // Sync transaction means parallel requests in this process cannot overbook.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { count } = this.db.prepare('SELECT count(*) AS count FROM workspaces').get();
      if (count >= this.maxWorkspaces) throw new Error('All temporary workspaces are in use. Close one or wait for idle cleanup.');
      this.db.prepare('INSERT INTO workspaces (id,container_name,created_at,last_used_at,state) VALUES (?,?,?,?,?)')
        .run(id, name, now, now, 'creating');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    try {
      await this.docker([
        'run', '--detach',
        ...this.containerArgs(name, [WORKSPACE_LABEL, `${WORKSPACE_ID_LABEL}=${id}`]),
        this.sandboxImage,
        '/bin/sh', '-c', 'while :; do /bin/sleep 3600; done',
      ], { timeout: 15_000 });
      const container = await this.verify(this.row(id), { requireRunning: true });
      this.db.prepare("UPDATE workspaces SET state='ready', container_id=? WHERE id=?")
        .run(container.Id, id);
      return id;
    } catch (error) {
      // Keep the deleting row for next startup if Docker cleanup fails.
      try { await this.deleteRow(this.row(id)); } catch (cleanupError) {
        throw new Error(`Could not create workspace: ${error.message}; cleanup also failed: ${cleanupError.message}`);
      }
      throw new Error(`Could not create gVisor workspace: ${error.message}`);
    }
  }

  async execute(id, callback) {
    const row = this.row(id);
    if (!row || !['ready'].includes(row.state) || this.expired(row)) {
      if (row?.state === 'ready' && this.expired(row)) await this.remove(id);
      throw new Error('Workspace missing, expired, or already in use. Create a new workspace or retry.');
    }
    // Mark busy BEFORE awaiting Docker; another call cannot concurrently exec
    // or destroy the same workspace. Stale busy state is discarded at restart.
    const updated = this.db.prepare("UPDATE workspaces SET state='busy', last_used_at=? WHERE id=? AND state='ready'")
      .run(this.now(), id);
    if (updated.changes !== 1) throw new Error('Workspace is already in use.');
    let broken = false;
    try {
      const container = await this.verify(this.row(id), { requireRunning: true });
      return await callback(container.Name.slice(1));
    } catch (error) {
      // A missing/altered container may mean state was lost; never reuse it.
      if (/identity mismatch|not running|no Docker container/i.test(error.message)) broken = true;
      throw error;
    } finally {
      if (broken) {
        this.db.prepare("UPDATE workspaces SET state='deleting' WHERE id=? AND state='busy'").run(id);
        try { await this.deleteRow({ ...row, state: 'deleting' }); } catch (error) {
          console.error('Failed to discard broken workspace:', error.message);
        }
      } else {
        this.db.prepare("UPDATE workspaces SET state='ready', last_used_at=? WHERE id=? AND state='busy'")
          .run(this.now(), id);
      }
    }
  }

  list() {
    const now = this.now();
    return this.rows().map((row) => ({
      workspace_id: row.id,
      state: row.state,
      created_at: new Date(row.created_at).toISOString(),
      last_used_at: new Date(row.last_used_at).toISOString(),
      expires_at: new Date(Math.min(row.created_at + this.maxLifetimeMs, row.last_used_at + this.idleTtlMs)).toISOString(),
      expired: this.expired(row, now),
    }));
  }

  inspect(id) {
    const record = this.list().find((row) => row.workspace_id === id);
    if (!record) throw new Error('Workspace not found.');
    return record;
  }
}

export { MANAGED_LABEL, WORKSPACE_LABEL };
