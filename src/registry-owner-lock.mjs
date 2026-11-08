/**
 * Exclusive OS-backed owner lock for the SQLite workspace registry.
 *
 * flock(1) holds the kernel lock through a subprocess which waits on stdin.
 * Unlike PID files the lock is released automatically after an abrupt crash.
 * Do not unlink the lock file: inode replacement can create two lock owners.
 */
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

export class RegistryOwnerLock {
  constructor(path) {
    if (!isAbsolute(path)) throw new Error('Registry lock path must be absolute.');
    this.path = path;
    this.child = null;
    this.closed = null;
    this.releasing = false;
    this.held = false;
  }

  async acquire() {
    if (process.platform !== 'linux') throw new Error('Registry ownership requires Linux flock(1).');
    if (this.child) throw new Error('Registry owner lock already acquired.');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // The parent directory is private, but also refuse a replaced/symlink lock path.
    try {
      const handle = await open(this.path, 'wx', 0o600);
      await handle.close();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Registry owner lock is not a regular file.');
    }
    await chmod(this.path, 0o600);
    const child = spawn('flock', [
      '-n', '-E', '73', this.path, 'sh', '-c',
      'printf "ACQUIRED\\n"; exec cat >/dev/null',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1024); });
    this.closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    try {
      await new Promise((resolve, reject) => {
        let ready = false;
        let output = '';
        const timer = setTimeout(() => reject(new Error('Timed out acquiring registry owner lock.')), 5000);
        const done = (error) => {
          if (ready) return;
          ready = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (output.includes('ACQUIRED\n')) done();
        });
        child.once('error', (error) => done(new Error(`Could not launch flock(1): ${error.message}`)));
        child.once('close', (code) => done(new Error(
          code === 73
            ? 'SQLite registry is already owned by another MCP process.'
            : `Could not acquire SQLite registry lock (exit ${code}): ${stderr || 'flock failed'}`,
        )));
      });
      this.held = true;
      child.once('exit', () => {
        if (!this.releasing && this.held) {
          console.error('SQLite registry ownership lock was lost unexpectedly. Shutting down to prevent concurrent owners.');
          process.kill(process.pid, 'SIGTERM');
        }
      });
    } catch (error) {
      this.releasing = true;
      child.stdin.end();
      child.kill();
      await this.closed;
      this.child = null;
      throw error;
    }
  }

  async release() {
    if (!this.child) return;
    this.releasing = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child?.kill('SIGKILL'), 2000);
    timer.unref();
    try { await this.closed; }
    finally {
      clearTimeout(timer);
      this.held = false;
      this.child = null;
    }
  }
}
