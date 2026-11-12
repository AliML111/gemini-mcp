import { childEnvironment } from './child-environment.mjs';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, opendir, readFile, readdir, realpath, rm, stat, writeFile, rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const managedLabel = 'gemini-mcp-poc.project=true';
const sessionLabel = 'gemini-mcp-poc.project-session=true';
const previewLabel = 'gemini-mcp-poc.preview=true';
const projectNamePrefix = 'gemini-mcp-project-session-';
const projectImage = 'gemini-mcp-sandbox:0.1.0';
const workspaceBytes = 384 * 1024 * 1024;
const commandTimeoutSeconds = 180;
const maxCommandOutputBytes = 64 * 1024;
const maxDiffBytes = 512 * 1024;
const maxSnapshotBytes = 256 * 1024 * 1024;
const maxSnapshotFiles = 30_000;
const maxSnapshotEntries = 30_000;
const maxSnapshotDepth = 64;
const previewTtlMs = 30 * 60 * 1000;
const sessionMaxLifetimeMs = 2 * 60 * 60 * 1000;
const maxProjectSessions = 2;
const maxConcurrentChecks = 1;
const reviewsDirectory = '.gemini-mcp/reviews';
const excludedDirectories = new Set([
  '.git', '.gemini-mcp', 'node_modules', 'vendor', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.output', '.cache', '.turbo', '.venv', 'venv', '__pycache__',
  '.aws', '.ssh', '.kube', '.gnupg', '.secrets',
]);
const excludedFiles = new Set([
  '.npmrc', '.netrc', '.pypirc', '.git-credentials', '.yarnrc.yml', '.dockerconfigjson',
  'credentials', 'credential', 'secrets', 'secret',
]);
const imageTypes = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
]);

function isWithin(target, root) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function validProjectId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function safeArtifactName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(value)
    && !value.includes('..');
}

function sensitivePath(path, { allowExampleEnv = false } = {}) {
  const components = path.split(/[\\/]/).filter(Boolean);
  return components.some((name, index) => {
    if (allowExampleEnv && index === components.length - 1 && name === '.env.example') return false;
    return /^\.env(?:\..*)?$/i.test(name)
      || excludedFiles.has(name.toLowerCase())
      || /^credentials?\.(?:json|ya?ml|toml|txt)$/i.test(name)
      || /^id_(?:rsa|dsa|ecdsa|ed25519|ed448)(?:_sk)?(?:\..*)?$/i.test(name)
      || /\.(?:pem|key|p12|pfx)$/i.test(name);
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function previewStopScript() {
  return [
    'from pathlib import Path',
    'import os, signal, time',
    "pid_file = Path('/tmp/gemini-project-preview.pid')",
    'if not pid_file.exists(): raise SystemExit(0)',
    'try: root = int(pid_file.read_text().strip())',
    'except Exception: root = -1',
    'def descendants(pid):',
    '  try: text = Path(f"/proc/{pid}/task/{pid}/children").read_text().strip()',
    '  except Exception: return []',
    '  found = []',
    '  for value in text.split():',
    '    child = int(value); found.extend(descendants(child)); found.append(child)',
    '  return found',
    'if root > 1:',
    '  tree = descendants(root) + [root]',
    '  for pid in reversed(tree):',
    '    try: os.kill(pid, signal.SIGTERM)',
    '    except ProcessLookupError: pass',
    '  time.sleep(0.2)',
    '  for pid in reversed(tree):',
    '    try: os.kill(pid, signal.SIGKILL)',
    '    except ProcessLookupError: pass',
    'pid_file.unlink(missing_ok=True)',
  ].join('\n');
}

function missingContainer(error) {
  return /no such (?:object|container)|not found/i.test(`${error.stderr ?? ''}\n${error.message ?? ''}`);
}

function truncateOutput(stdout = '', stderr = '') {
  let output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n') || '(no output)';
  const bytes = Buffer.from(output, 'utf8');
  if (bytes.byteLength <= maxCommandOutputBytes) return output;
  const marker = Buffer.from('\n[output truncated at 64 KiB]', 'utf8');
  output = `${bytes.subarray(0, maxCommandOutputBytes - marker.byteLength).toString('utf8')}${marker.toString('utf8')}`;
  return output;
}

export async function loadProjectProfiles(raw = process.env.MCP_PROJECTS_JSON) {
  if (!raw) throw new Error('MCP_PROJECTS_JSON must contain at least one explicitly approved project profile.');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`MCP_PROJECTS_JSON is not valid JSON: ${error.message}`); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) {
    throw new Error('MCP_PROJECTS_JSON must be an array with 1 to 20 project profiles.');
  }

  const ids = new Set();
  const profiles = new Map();
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || !validProjectId(item.id) || ids.has(item.id)) {
      throw new Error('Each project profile needs a unique id using letters, numbers, underscores, or hyphens.');
    }
    if (typeof item.root !== 'string' || !isAbsolute(item.root)) {
      throw new Error(`Project ${item.id} needs an absolute root path.`);
    }
    const root = await realpath(item.root);
    if (!(await stat(root)).isDirectory()) throw new Error(`Project root is not a directory: ${item.root}`);
    const commands = item.commands ?? {};
    if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
      throw new Error(`Project ${item.id} commands must be an object.`);
    }
    const validatedCommands = {};
    for (const action of ['install', 'build', 'test', 'lint']) {
      const command = commands[action];
      if (command === undefined) continue;
      if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command, 'utf8') > 1_000) {
        throw new Error(`Project ${item.id} command ${action} must be a non-empty string up to 1,000 bytes.`);
      }
      validatedCommands[action] = command.trim();
    }
    const preview = item.preview;
    let validatedPreview = null;
    if (preview !== undefined && preview !== null) {
      if (!preview || typeof preview !== 'object' || typeof preview.command !== 'string'
          || !preview.command.trim() || Buffer.byteLength(preview.command, 'utf8') > 1_000
          || !Number.isInteger(preview.port) || preview.port < 1024 || preview.port > 65535) {
        throw new Error(`Project ${item.id} preview needs a command (up to 1,000 bytes) and a port from 1024 to 65535.`);
      }
      validatedPreview = { command: preview.command.trim(), port: preview.port };
    }
    ids.add(item.id);
    profiles.set(item.id, {
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 100) : item.id,
      root,
      commands: validatedCommands,
      preview: validatedPreview,
    });
  }
  return profiles;
}

export class ProjectWorkflow {
  constructor({
    docker,
    dockerInput,
    profiles,
    playwrightOutputRoot = process.env.MCP_PLAYWRIGHT_OUTPUT_ROOT ?? '/tmp/gemini-mcp-playwright-output',
    snapshotLimits = {},
    allowNetworkAccess = false,
  }) {
    if (typeof docker !== 'function' || typeof dockerInput !== 'function' || !(profiles instanceof Map) || profiles.size === 0) {
      throw new Error('ProjectWorkflow requires Docker commands, streamed Docker input, and configured project profiles.');
    }
    this.docker = docker;
    this.dockerInput = dockerInput;
    this.profiles = profiles;
    this.snapshotLimits = {
      maxBytes: snapshotLimits.maxBytes ?? maxSnapshotBytes,
      maxFiles: snapshotLimits.maxFiles ?? maxSnapshotFiles,
      maxEntries: snapshotLimits.maxEntries ?? maxSnapshotEntries,
      maxDepth: snapshotLimits.maxDepth ?? maxSnapshotDepth,
    };
    if (Object.values(this.snapshotLimits).some((limit) => !Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error('Project snapshot limits must be positive safe integers.');
    }
    this.allowNetworkAccess = allowNetworkAccess === true;
    this.sessions = new Map();
    this.pendingSessions = 0;
    this.pendingReviews = 0;
    this.activeReviews = new Set();
    this.activeChecks = 0;
    this.playwrightOutputRoot = playwrightOutputRoot;
    this.cleanupTimer = null;
    this.cleanupPromise = null;
  }

  project(projectId) {
    const profile = this.profiles.get(projectId);
    if (!profile) throw new Error(`Unknown project id: ${projectId}`);
    return profile;
  }

  listProjects() {
    return [...this.profiles.values()].map((profile) => ({
      id: profile.id,
      name: profile.name,
      checks: Object.keys(profile.commands),
      preview_available: Boolean(profile.preview),
    }));
  }

  async initialize() {
    if (this.cleanupTimer) return;
    await this.ensurePreviewNetwork();
    await this.cleanupOrphanSessions();
    this.cleanupTimer = setInterval(() => this.runCleanup(), 30_000);
    this.cleanupTimer.unref();
  }

  async close() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    await this.cleanupPromise?.catch(() => {});
    const results = await Promise.allSettled([...this.sessions.keys()].map((id) => this.stopProjectSession(id)));
    for (const result of results) {
      if (result.status === 'rejected') console.error('Could not stop a project session during shutdown:', result.reason?.message ?? result.reason);
    }
  }

  runCleanup() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.cleanupExpiredSessions()
      .catch((error) => console.error('Project session cleanup failed:', error.message))
      .finally(() => { this.cleanupPromise = null; });
    return this.cleanupPromise;
  }

  async ensurePreviewNetwork() {
    const name = 'gemini-mcp-project-internal';
    try {
      const { stdout } = await this.docker(['network', 'inspect', name]);
      const [network] = JSON.parse(stdout);
      if (network.Driver !== 'bridge' || network.Internal !== true
          || network.Labels?.['gemini-mcp-poc.project-network'] !== 'true') {
        throw new Error(`Docker network ${name} exists but is not the expected internal project network.`);
      }
      return;
    } catch (error) {
      if (!/no such network|not found/i.test(`${error.message}\n${error.stderr ?? ''}`)) throw error;
    }
    await this.docker([
      'network', 'create', '--driver=bridge', '--internal', '--label', 'gemini-mcp-poc.project-network=true', name,
    ]);
  }

  projectContainerArgs(name, { projectId, network = 'none', previewPort = null, expiresAt = null } = {}) {
    const labels = [managedLabel, sessionLabel, `${managedLabel.split('=')[0]}.project-id=${projectId}`];
    if (previewPort) labels.push(previewLabel);
    if (expiresAt) labels.push(`${managedLabel.split('=')[0]}.expires-at=${expiresAt}`);
    return [
      '--init', '--pull=never', '--rm', '--name', name,
      ...labels.flatMap((label) => ['--label', label]),
      '--runtime=runsc-project',
      '--memory=512m', '--memory-swap=512m', '--cpus=0.5', '--pids-limit=128',
      `--network=${network}`,
      ...(previewPort && network === 'bridge' ? ['--publish', `127.0.0.1::${previewPort}/tcp`] : []),
      '--read-only', '--user=10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges=true',
      '--ulimit=nofile=512:512', '--log-driver=none', '--stop-timeout=2', '--shm-size=16m',
      '--env', 'NODE_OPTIONS=--max-old-space-size=384',
      '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=32m,uid=10001,gid=10001,mode=1777',
      `--tmpfs=/workspace:rw,nosuid,nodev,size=${workspaceBytes},uid=10001,gid=10001,mode=700`,
      '--workdir=/workspace', '--hostname=project-sandbox',
    ];
  }

  async createProjectContainer(name, { projectId, ...options } = {}) {
    await this.docker([
      'create', ...this.projectContainerArgs(name, { ...options, projectId }), projectImage,
      '/bin/sh', '-c', 'sleep 7200',
    ], { timeout: 15_000 });
    await this.docker(['start', name], { timeout: 15_000 });
  }

  async snapshotProject(root) {
    const directory = await mkdtemp(join(tmpdir(), 'gemini-mcp-project-'));
    let totalBytes = 0;
    let totalFiles = 0;
    let totalEntries = 0;
    const filesToCopy = [];
    const { maxBytes, maxFiles, maxEntries, maxDepth } = this.snapshotLimits;
    const visit = async (source, target, depth = 0) => {
      const dir = await opendir(source);
      try {
        for await (const entry of dir) {
          totalEntries += 1;
          if (totalEntries > maxEntries) {
            throw new Error(`Project snapshot exceeds ${maxEntries} total directory entries.`);
          }
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory() && (excludedDirectories.has(entry.name) || sensitivePath(entry.name))) continue;
          if (entry.isFile() && sensitivePath(entry.name, { allowExampleEnv: true })) continue;
          const from = join(source, entry.name);
          const to = join(target, entry.name);
          if (entry.isDirectory()) {
            if (depth >= maxDepth) throw new Error(`Project snapshot exceeds maximum directory depth ${maxDepth}.`);
            await mkdir(to, { mode: 0o700 });
            await visit(from, to, depth + 1);
          } else if (entry.isFile()) {
            const info = await lstat(from);
            totalFiles += 1;
            totalBytes += info.size;
            if (totalFiles > maxFiles || totalBytes > maxBytes) {
              throw new Error(`Project snapshot exceeds ${maxFiles} files or ${Math.round(maxBytes / 1024 / 1024)} MiB.`);
            }
            filesToCopy.push({ from, to, mode: info.mode & 0o755 });
          }
        }
      } finally {
        await dir.close().catch(() => {});
      }
    };
    try {
      await visit(root, directory);
      let nextFile = 0;
      let copyError = null;
      const workerCount = Math.min(8, filesToCopy.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (!copyError) {
          const file = filesToCopy[nextFile++];
          if (!file) return;
          try {
            await copyFile(file.from, file.to);
            await chmod(file.to, file.mode);
          } catch (error) {
            copyError = error;
          }
        }
      }));
      if (copyError) throw copyError;
      return { directory, totalBytes, totalFiles, totalEntries };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async uploadSnapshot(snapshot, containerName) {
    const archive = spawn('tar', ['-C', snapshot.directory, '-cf', '-', '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const archiveErrors = [];
    archive.stderr.on('data', (chunk) => {
      if (Buffer.concat(archiveErrors).byteLength < 16 * 1024) archiveErrors.push(Buffer.from(chunk));
    });
    const archiveFinished = new Promise((resolvePromise, rejectPromise) => {
      archive.once('error', rejectPromise);
      archive.once('close', (code, signal) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`Could not archive project snapshot (${signal ?? code}): ${Buffer.concat(archiveErrors).toString('utf8')}`));
      });
    });
    try {
      const dockerFinished = this.dockerInput(
        ['exec', '-i', containerName, 'tar', '-xf', '-', '-C', '/workspace'],
        archive.stdout,
        { timeout: 120_000 },
      );
      await Promise.all([dockerFinished, archiveFinished]);
    } catch (error) {
      archive.kill('SIGTERM');
      await archiveFinished.catch(() => {});
      throw error;
    }
  }

  async createProjectSession({ project_id: projectId, internet_access: internetAccess = false, review_id: reviewId = null }, ownerId = null) {
    if (internetAccess && !this.allowNetworkAccess) {
      throw new Error('Project network access is disabled by the MCP server administrator. Set MCP_PROJECT_ALLOW_NETWORK=true to allow internet_access=true.');
    }
    const profile = this.project(projectId);
    await this.runCleanup();
    if (this.sessions.size + this.pendingSessions >= maxProjectSessions) throw new Error(`At most ${maxProjectSessions} project sessions can run at once.`);
    this.pendingSessions += 1;
    const id = randomUUID();
    const containerName = `${projectNamePrefix}${id}`;
    let snapshot = null;
    const now = Date.now();
    const maxExpiresAt = now + sessionMaxLifetimeMs;
    try {
      if (reviewId) await this.getReviewDirectory(profile, reviewId);
      snapshot = await this.snapshotProject(profile.root);
      await this.createProjectContainer(containerName, {
        projectId,
        network: internetAccess ? 'bridge' : 'gemini-mcp-project-internal',
        previewPort: profile.preview?.port ?? null,
        expiresAt: now + previewTtlMs,
      });
      await this.uploadSnapshot(snapshot, containerName);
      let previewUrl = null;
      if (profile.preview && internetAccess) {
        const { stdout } = await this.docker(['inspect', containerName]);
        const [container] = JSON.parse(stdout);
        const hostPort = container.NetworkSettings?.Ports?.[`${profile.preview.port}/tcp`]?.[0]?.HostPort;
        if (!hostPort || !/^\d+$/.test(hostPort)) throw new Error('Docker did not publish the preview port on loopback.');
        previewUrl = `http://127.0.0.1:${hostPort}`;
      }
      const session = {
        session_id: id,
        project_id: projectId,
        container_name: containerName,
        ownerId,
        preview_url: previewUrl,
        preview_running: false,
        internet_access: internetAccess,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + previewTtlMs).toISOString(),
        max_expires_at: new Date(maxExpiresAt).toISOString(),
      };
      if (reviewId) {
        await this.saveTextArtifact(profile, reviewId, 'project-session.json', JSON.stringify({
          session_id: id, project_id: projectId, preview_url: previewUrl, internet_access: internetAccess,
          expires_at: session.expires_at, max_expires_at: session.max_expires_at,
        }, null, 2), 'session');
      }
      this.sessions.set(id, session);
      return { ...session, container_name: undefined, ownerId: undefined, network: internetAccess ? 'rootless bridge; outbound and reachable LAN access may be available' : 'internal; outbound disabled' };
    } catch (error) {
      this.sessions.delete(id);
      await this.docker(['rm', '--force', containerName], { timeout: 10_000 }).catch(() => {});
      throw error;
    } finally {
      try {
        if (snapshot) await rm(snapshot.directory, { recursive: true, force: true });
      } finally {
        this.pendingSessions -= 1;
      }
    }
  }

  projectSession(sessionId, projectId = null, { allowExpired = false } = {}) {
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId)) {
      throw new Error('session_id must be a UUID returned by start_project_session.');
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Project session ${sessionId} is not active; start a new session.`);
    if (projectId && session.project_id !== projectId) throw new Error('session_id belongs to a different configured project.');
    if (!allowExpired && (Date.parse(session.expires_at) <= Date.now() || Date.parse(session.max_expires_at) <= Date.now())) {
      throw new Error(`Project session ${sessionId} has expired; start a new session.`);
    }
    return session;
  }

  touchProjectSession(session) {
    const maxExpiresAt = Date.parse(session.max_expires_at);
    session.expires_at = new Date(Math.min(Date.now() + previewTtlMs, maxExpiresAt)).toISOString();
  }

  async runProjectChecks({ project_id: projectId, session_id: sessionId, actions, review_id: reviewId = null }) {
    const profile = this.project(projectId);
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 4
        || actions.some((action) => !['install', 'build', 'test', 'lint'].includes(action))) {
      throw new Error('actions must contain one to four of: install, build, test, lint.');
    }
    if (new Set(actions).size !== actions.length) throw new Error('actions must not contain duplicates.');
    const configured = actions.map((action) => {
      if (!profile.commands[action]) throw new Error(`Project ${projectId} has no configured ${action} command.`);
      return { action, command: profile.commands[action] };
    });
    if (reviewId) await this.getReviewDirectory(profile, reviewId);
    const session = this.projectSession(sessionId, projectId);
    if (this.activeChecks >= maxConcurrentChecks) throw new Error('The project runner is busy; retry after the active check finishes.');
    const id = randomUUID();
    const results = [];
    const startedAt = new Date().toISOString();
    this.touchProjectSession(session);
    this.activeChecks += 1;
    try {
      for (const { action, command } of configured) {
        const result = await this.executeProjectCommand(session.container_name, command);
        results.push({ action, command, ...result });
        if (result.exit_code !== 0) break;
      }
    } finally {
      this.touchProjectSession(session);
      this.activeChecks -= 1;
    }
    const report = {
      project_id: projectId,
      run_id: id,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      session_id: sessionId,
      internet_access: session.internet_access,
      results,
      passed: results.length === configured.length && results.every((result) => result.exit_code === 0),
    };
    if (reviewId) {
      await this.saveTextArtifact(profile, reviewId, 'project-check-results.json', JSON.stringify(report, null, 2), 'check-results');
      report.review_artifact = `${reviewsDirectory}/${reviewId}/project-check-results.json`;
    }
    return report;
  }

  async getProjectDiff({ project_id: projectId, review_id: reviewId = null }) {
    const profile = this.project(projectId);
    if (reviewId) await this.getReviewDirectory(profile, reviewId);
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
    };
    const git = async (args, maxBuffer = 1024 * 1024) => execFileAsync('git', args, {
      env: childEnvironment(),
      cwd: profile.root,
      env,
      timeout: 5_000,
      maxBuffer,
      encoding: 'utf8',
      windowsHide: true,
    });
    let status;
    let changedPaths;
    let untrackedPaths;
    const excludedPath = (path) => sensitivePath(path)
      || path.split(/[\\/]/).some((part) => excludedDirectories.has(part) || excludedFiles.has(part));
    try {
      const [statusResult, pathsResult, untrackedResult] = await Promise.all([
        git(['-c', 'core.fsmonitor=false', 'status', '--short', '--branch', '--untracked-files=all'], 64 * 1024),
        git(['--literal-pathspecs', '-c', 'core.fsmonitor=false', 'diff', '--name-only', '-z', 'HEAD'], maxDiffBytes),
        git(['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'], maxDiffBytes),
      ]);
      status = statusResult.stdout.trimEnd().split('\n')
        .filter((line) => line.startsWith('##') || !excludedPath(line.slice(3).replace(/^"|"$/g, ''))).join('\n');
      const trackedPaths = pathsResult.stdout.split('\0').filter((path) => path && !excludedPath(path));
      const candidates = untrackedResult.stdout.split('\0').filter((path) => path && !excludedPath(path));
      untrackedPaths = [];
      for (const path of candidates) {
        const absolutePath = resolve(profile.root, path);
        if (!isWithin(absolutePath, profile.root)) continue;
        try {
          const info = await lstat(absolutePath);
          if (info.isFile() && !info.isSymbolicLink()) untrackedPaths.push(path);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      changedPaths = [...new Set([...trackedPaths, ...untrackedPaths])].slice(0, 2_000);
      untrackedPaths = untrackedPaths.filter((path) => changedPaths.includes(path));
    } catch (error) {
      if (error.code === 128 || /not a git repository/i.test(`${error.stderr ?? ''}\n${error.message ?? ''}`)) {
        throw new Error(`Project ${projectId} is not a Git worktree.`);
      }
      throw new Error(`Could not read Git status and changed paths: ${error.message}`);
    }
    let diff = '';
    let truncated = false;
    const trackedPaths = changedPaths.filter((path) => !untrackedPaths.includes(path));
    if (trackedPaths.length > 0) {
      try {
        const result = await git([
          '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
          'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', 'HEAD', '--', ...trackedPaths,
        ], maxDiffBytes + 1);
        diff = result.stdout;
      } catch (error) {
        if (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(`Could not read the Git diff: ${error.message}`);
        diff = typeof error.stdout === 'string' ? error.stdout : '';
        truncated = true;
      }
    }
    const readUntrackedDiff = async (path) => {
      try {
        const emptyFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
        const result = await git([
          '-c', 'core.pager=cat', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', '--no-index', '--', emptyFile, path,
        ], maxDiffBytes + 1);
        return { stdout: result.stdout, truncated: false };
      } catch (error) {
        if (error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout, truncated: false };
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return { stdout: typeof error.stdout === 'string' ? error.stdout : '', truncated: true };
        }
        return { error };
      }
    };
    for (let offset = 0; offset < untrackedPaths.length; offset += 4) {
      const batch = await Promise.all(untrackedPaths.slice(offset, offset + 4).map(readUntrackedDiff));
      for (const result of batch) {
        if (result.error) throw new Error(`Could not read untracked file diff: ${result.error.message}`);
        diff += result.stdout;
        if (result.truncated || Buffer.byteLength(diff, 'utf8') > maxDiffBytes) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    truncated ||= Buffer.byteLength(diff, 'utf8') > maxDiffBytes;
    if (truncated) diff = `${Buffer.from(diff, 'utf8').subarray(0, maxDiffBytes).toString('utf8')}\n[diff truncated at 512 KiB]\n`;
    const report = { project_id: projectId, status, changed_paths: changedPaths.length, diff, diff_truncated: truncated };
    if (reviewId) {
      const saved = await this.saveTextArtifact(profile, reviewId, 'git-diff.patch', diff, 'diff');
      report.review_artifact = saved.path;
    }
    return report;
  }

  async executeProjectCommand(containerName, command) {
    const start = Date.now();
    const executable = [
      'exec', '--workdir=/workspace', containerName,
      '/usr/bin/timeout', '-s', 'TERM', '-k', '3s', `${commandTimeoutSeconds}s`,
      '/bin/bash', '--noprofile', '--norc', '-lc', command,
    ];
    try {
      const result = await this.docker(executable, { timeout: (commandTimeoutSeconds + 15) * 1_000, maxBuffer: maxCommandOutputBytes * 2 });
      return { exit_code: 0, timed_out: false, duration_ms: Date.now() - start, output: truncateOutput(result.stdout, result.stderr) };
    } catch (error) {
      const stdout = typeof error.stdout === 'string' ? error.stdout : '';
      const stderr = typeof error.stderr === 'string' ? error.stderr : '';
      if (error.code === 124 || error.killed || error.code === 'ETIMEDOUT') {
        return { exit_code: 124, timed_out: true, duration_ms: Date.now() - start, output: truncateOutput(stdout, `${stderr}\nCommand exceeded the ${commandTimeoutSeconds}-second limit.`) };
      }
      if (Number.isInteger(error.code)) {
        return { exit_code: error.code, timed_out: false, duration_ms: Date.now() - start, output: truncateOutput(stdout, stderr) };
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { exit_code: 1, timed_out: false, duration_ms: Date.now() - start, output: truncateOutput(stdout, `${stderr}\nOutput exceeded the capture limit.`) };
      }
      throw new Error(`Project command could not run in the gVisor container: ${error.message}`);
    }
  }

  async startPreview({ project_id: projectId, session_id: sessionId, review_id: reviewId = null }) {
    const profile = this.project(projectId);
    if (!profile.preview) throw new Error(`Project ${projectId} has no preview command configured.`);
    if (reviewId) await this.getReviewDirectory(profile, reviewId);
    const session = this.projectSession(sessionId, projectId);
    if (!session.preview_url) {
      throw new Error(`Project preview needs a rootless-bridge session so Docker can publish its port. Stop this session and start a new one with internet_access=true; project commands and preview code will then have outbound and possible host/LAN network access.`);
    }
    if (session.preview_running) throw new Error(`Project session ${sessionId} already has a preview running.`);
    const launchCommand = `nohup /bin/bash --noprofile --norc -lc ${shellQuote(profile.preview.command)} > /tmp/gemini-project-preview.log 2>&1 < /dev/null & echo $! > /tmp/gemini-project-preview.pid`;
    try {
      await this.docker([
        'exec', '--workdir=/workspace', session.container_name,
        '/bin/sh', '-c', launchCommand,
      ], { timeout: 10_000 });
      session.preview_running = true;
      await this.waitForPreview(session.preview_url, 30_000);
      this.touchProjectSession(session);
      if (reviewId) {
        await this.saveTextArtifact(profile, reviewId, 'preview.json', JSON.stringify({
          session_id: sessionId,
          project_id: projectId,
          preview_url: session.preview_url,
          expires_at: session.expires_at,
          network: session.internet_access ? 'internet enabled' : 'internal only',
        }, null, 2), 'preview');
      }
      return {
        preview_id: sessionId,
        session_id: sessionId,
        project_id: projectId,
        preview_url: session.preview_url,
        expires_at: session.expires_at,
        ttl_minutes: Math.round(previewTtlMs / 60_000),
        network: session.internet_access ? 'rootless bridge remains enabled for this session' : 'internal; preview port published on 127.0.0.1 only',
      };
    } catch (error) {
      await this.docker(['exec', session.container_name, 'python3', '-c', previewStopScript()], { timeout: 5_000 }).catch(() => {});
      session.preview_running = false;
      const logs = await this.docker(['exec', session.container_name, 'cat', '/tmp/gemini-project-preview.log'], { timeout: 3_000, maxBuffer: maxCommandOutputBytes }).catch(() => ({ stdout: '', stderr: '' }));
      const diagnostic = truncateOutput(logs.stdout, logs.stderr);
      throw new Error(`${error.message}${diagnostic !== '(no output)' ? `\nPreview log excerpt:\n${diagnostic}` : ''}`);
    }
  }

  async waitForPreview(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'preview did not respond';
    let retryDelayMs = 50;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000), redirect: 'manual' });
        await response.body?.cancel().catch(() => {});
        if (response.status < 500) return;
        lastError = `preview returned HTTP ${response.status}`;
      } catch (error) { lastError = error.message; }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(retryDelayMs, remainingMs)));
      retryDelayMs = Math.min(retryDelayMs * 2, 500);
    }
    throw new Error(`Preview did not become ready within ${Math.round(timeoutMs / 1000)} seconds: ${lastError}`);
  }

  async stopPreview(previewId) {
    const session = this.projectSession(previewId, null, { allowExpired: true });
    if (!session.preview_running) return { preview_id: previewId, session_id: previewId, stopped: false, output: 'No preview process was marked running.' };
    await this.docker(['exec', session.container_name, 'python3', '-c', previewStopScript()], { timeout: 5_000 });
    const logs = await this.docker(['exec', session.container_name, 'cat', '/tmp/gemini-project-preview.log'], { timeout: 3_000, maxBuffer: maxCommandOutputBytes }).catch(() => ({ stdout: '', stderr: '' }));
    session.preview_running = false;
    this.touchProjectSession(session);
    return { preview_id: previewId, session_id: previewId, stopped: true, output: truncateOutput(logs.stdout, logs.stderr) };
  }

  async stopProjectSession(sessionId) {
    const session = this.projectSession(sessionId, null, { allowExpired: true });
    try { await this.docker(['rm', '--force', session.container_name], { timeout: 10_000 }); }
    catch (error) { if (!missingContainer(error)) throw error; }
    this.sessions.delete(sessionId);
    return { session_id: sessionId, stopped: true };
  }

  async listProjectSessions(ownerId = null) {
    return {
      sessions: [...this.sessions.values()].filter((session) => session.ownerId === ownerId).map(({ session_id, project_id, preview_url, preview_running, internet_access, expires_at, max_expires_at }) => ({
        session_id, project_id, preview_url, preview_running, internet_access, expires_at, max_expires_at,
      })),
    };
  }

  async cleanupOrphanSessions() {
    const { stdout } = await this.docker(['ps', '-aq', '--filter', `label=${managedLabel}`, '--filter', `label=${sessionLabel}`]);
    for (const id of stdout.trim().split('\n').filter(Boolean)) {
      const { stdout: details } = await this.docker(['inspect', id]);
      const [container] = JSON.parse(details);
      const labels = container.Config?.Labels ?? {};
      if (!container.Name?.startsWith(`/${projectNamePrefix}`)
          || labels[managedLabel.split('=')[0]] !== 'true' || labels[sessionLabel.split('=')[0]] !== 'true') {
        throw new Error(`Unexpected container matched the project session labels (${id}); refusing cleanup.`);
      }
      await this.docker(['rm', '--force', id], { timeout: 10_000 });
    }
  }

  async cleanupExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expires_at) <= now || Date.parse(session.max_expires_at) <= now) {
        try {
          await this.stopProjectSession(id);
          this.sessions.delete(id);
        } catch (error) {
          if (missingContainer(error)) this.sessions.delete(id);
          else console.error(`Could not clean expired project session ${id}:`, error.message);
        }
      }
    }
  }

  async ensureReviewBase(profile, { create = false } = {}) {
    let current = profile.root;
    for (const part of reviewsDirectory.split('/')) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Review paths cannot use symlinks or non-directory entries.');
      } catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        await mkdir(current, { mode: 0o700 });
      }
      const canonical = await realpath(current);
      if (!isWithin(canonical, profile.root)) throw new Error('Review artifact path escaped the configured project root.');
      current = canonical;
    }
    return current;
  }

  async ensureReviewDirectory(profile, reviewId, { create = false } = {}) {
    if (typeof reviewId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reviewId)) {
      throw new Error('review_id must be a UUID returned by create_review_run.');
    }
    const base = await this.ensureReviewBase(profile, { create });
    const directory = join(base, reviewId);
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Review paths cannot use symlinks or non-directory entries.');
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await mkdir(directory, { mode: 0o700 });
    }
    const canonical = await realpath(directory);
    if (!isWithin(canonical, profile.root)) throw new Error('Review artifact path escaped the configured project root.');
    return canonical;
  }

  async getReviewDirectory(profile, reviewId) {
    const directory = await this.ensureReviewDirectory(profile, reviewId);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    if (manifest.project_id !== profile.id || manifest.review_id !== reviewId) throw new Error('Review manifest does not match the configured project.');
    return directory;
  }

  async writeReviewFile(directory, name, content) {
    if (!safeArtifactName(name)) throw new Error('Artifact filename may contain only letters, numbers, dot, underscore, and hyphen.');
    const destination = join(directory, name);
    const current = await lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (current?.isSymbolicLink() || (current && !current.isFile())) throw new Error('Artifact destination must be a regular file.');
    if (!current && (await readdir(directory)).length >= 20) throw new Error('Review artifact limit reached.');
    const temporaryPath = join(directory, `.artifact-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, destination);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    return destination;
  }

  async withOwnedReview(projectId, reviewId, ownerId, action) {
    const key = `${projectId}:${reviewId}`;
    if (this.activeReviews.has(key)) throw new Error('Review is busy. Retry after the current operation finishes.');
    this.activeReviews.add(key);
    try {
      await this.requireReviewOwner(projectId, reviewId, ownerId);
      return await action();
    } finally {
      this.activeReviews.delete(key);
    }
  }

  async requireReviewOwner(projectId, reviewId, ownerId) {
    const directory = await this.getReviewDirectory(this.project(projectId), reviewId);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    if (!ownerId || manifest.owner_id !== ownerId) throw new Error('Review is not available to this client.');
  }

  async createReviewRun({ project_id: projectId, title, plan, checklist }, ownerId = null) {
    const profile = this.project(projectId);
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('title must be 1 to 200 characters.');
    if (typeof plan !== 'string' || plan.length > 20_000) throw new Error('plan must be at most 20,000 characters.');
    if (!Array.isArray(checklist) || checklist.length > 50 || checklist.some((item) => typeof item !== 'string' || !item.trim() || item.length > 300)) {
      throw new Error('checklist must contain at most 50 non-empty items, each up to 300 characters.');
    }
    const reviewId = randomUUID();
    const base = await this.ensureReviewBase(profile, { create: true });
    this.pendingReviews += 1;
    let directory;
    try {
      const entries = await readdir(base);
      if (entries.length + this.pendingReviews > 100) throw new Error('Project review storage is full. Archive older review folders locally.');
      directory = await this.ensureReviewDirectory(profile, reviewId, { create: true });
    } finally {
      this.pendingReviews -= 1;
    }
    const createdAt = new Date().toISOString();
    const planBytes = Buffer.byteLength(`${plan.trim()}\n`, 'utf8');
    const checklistText = `${checklist.map((item) => `- [ ] ${item.trim()}`).join('\n')}\n`;
    const manifest = {
      project_id: projectId,
      review_id: reviewId,
      owner_id: ownerId,
      title: title.trim(),
      status: 'in_progress',
      created_at: createdAt,
      artifacts: [
        { filename: 'plan.md', kind: 'plan', bytes: planBytes, updated_at: createdAt },
        { filename: 'checklist.md', kind: 'checklist', bytes: Buffer.byteLength(checklistText, 'utf8'), updated_at: createdAt },
      ],
    };
    await this.writeReviewFile(directory, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    await this.writeReviewFile(directory, 'plan.md', `${plan.trim()}\n`);
    await this.writeReviewFile(directory, 'checklist.md', checklistText);
    return { project_id: projectId, review_id: reviewId, directory: join(reviewsDirectory, reviewId), manifest };
  }

  async updateReviewChecklist({ project_id: projectId, review_id: reviewId, items }) {
    const profile = this.project(projectId);
    if (!Array.isArray(items) || items.length > 50 || items.some((item) => !item || typeof item.text !== 'string'
        || !item.text.trim() || item.text.length > 300 || typeof item.complete !== 'boolean')) {
      throw new Error('items must contain up to 50 entries with text (1 to 300 characters) and a complete boolean.');
    }
    const directory = await this.getReviewDirectory(profile, reviewId);
    const content = `${items.map((item) => `- [${item.complete ? 'x' : ' '}] ${item.text.trim()}`).join('\n')}\n`;
    await this.writeReviewFile(directory, 'checklist.md', content);
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts = manifest.artifacts.filter((item) => item.filename !== 'checklist.md');
    manifest.artifacts.push({ filename: 'checklist.md', kind: 'checklist', bytes: Buffer.byteLength(content, 'utf8'), updated_at: new Date().toISOString() });
    await this.writeReviewFile(directory, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    return { project_id: projectId, review_id: reviewId, items: items.length, completed: items.filter((item) => item.complete).length };
  }

  async saveTextArtifact(profile, reviewId, filename, content, kind) {
    if (!safeArtifactName(filename) || ['manifest.json', 'plan.md', 'checklist.md'].includes(filename)
        || imageTypes.has(extname(filename).toLowerCase())) {
      throw new Error('Text artifact filename must be path-free, non-reserved, and not use an image extension.');
    }
    const directory = await this.getReviewDirectory(profile, reviewId);
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new Error('Text artifact must be at most 1 MiB.');
    const destination = await this.writeReviewFile(directory, filename, content);
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const artifacts = manifest.artifacts.filter((item) => item.filename !== filename);
    artifacts.push({ filename, kind, bytes: Buffer.byteLength(content, 'utf8'), updated_at: new Date().toISOString() });
    manifest.artifacts = artifacts;
    await this.writeReviewFile(directory, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    return { path: relative(profile.root, destination), bytes_written: Buffer.byteLength(content, 'utf8') };
  }

  async saveReviewArtifact({ project_id: projectId, review_id: reviewId, filename, kind, content }) {
    const allowedKinds = ['diff', 'check-results', 'browser-report', 'notes', 'summary'];
    if (!allowedKinds.includes(kind)) throw new Error(`kind must be one of: ${allowedKinds.join(', ')}.`);
    return this.saveTextArtifact(this.project(projectId), reviewId, filename, content, kind);
  }

  async saveReviewScreenshot({ project_id: projectId, review_id: reviewId, filename, source_path: sourcePath }) {
    const profile = this.project(projectId);
    if (!safeArtifactName(filename) || !imageTypes.has(extname(filename).toLowerCase())) {
      throw new Error('filename must end in .png, .jpg, .jpeg, or .webp.');
    }
    if (typeof sourcePath !== 'string' || !sourcePath.trim() || isAbsolute(sourcePath)) {
      throw new Error('source_path must be relative to the configured Playwright output directory.');
    }
    const sourceRoot = await realpath(this.playwrightOutputRoot).catch(() => null);
    if (!sourceRoot) throw new Error('Playwright output directory is not available; start the browser MCP with its configured output directory.');
    const source = await realpath(resolve(sourceRoot, sourcePath));
    if (!isWithin(source, sourceRoot)) throw new Error('Screenshot path is outside the configured Playwright output directory.');
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024) throw new Error('Screenshot must be a regular file no larger than 10 MiB.');
    const destinationDirectory = await this.getReviewDirectory(profile, reviewId);
    const destination = join(destinationDirectory, filename);
    const current = await lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (current?.isSymbolicLink() || (current && !current.isFile())) throw new Error('Artifact destination must be a regular file.');
    if (!current && (await readdir(destinationDirectory)).length >= 20) throw new Error('Review artifact limit reached.');
    const temporary = join(destinationDirectory, `.screenshot-${randomUUID()}.tmp`);
    try {
      await copyFile(source, temporary);
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    const manifestPath = join(destinationDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts = manifest.artifacts.filter((item) => item.filename !== filename);
    manifest.artifacts.push({ filename, kind: 'screenshot', media_type: imageTypes.get(extname(filename).toLowerCase()), bytes: info.size, updated_at: new Date().toISOString() });
    await this.writeReviewFile(destinationDirectory, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    return { path: relative(profile.root, destination), media_type: imageTypes.get(extname(filename).toLowerCase()), bytes_written: info.size };
  }

  async listReviewRuns(projectId, ownerId = null) {
    const profile = this.project(projectId);
    const directory = await this.ensureReviewBase(profile).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!directory) return { project_id: projectId, reviews: [] };
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      try {
        const manifest = JSON.parse(await readFile(join(directory, entry.name, 'manifest.json'), 'utf8'));
        if (manifest.project_id === projectId && manifest.review_id === entry.name && (manifest.owner_id ?? null) === ownerId) runs.push(manifest);
      } catch { /* Ignore incomplete or malformed review folders. */ }
    }
    runs.sort((left, right) => right.created_at.localeCompare(left.created_at));
    return { project_id: projectId, reviews: runs.slice(0, 100) };
  }

  async readReviewArtifact({ project_id: projectId, review_id: reviewId, filename }) {
    const profile = this.project(projectId);
    if (!safeArtifactName(filename)) throw new Error('filename must be a simple artifact filename.');
    const directory = await this.getReviewDirectory(profile, reviewId);
    const path = join(directory, filename);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Artifact must be a regular file.');
    if (imageTypes.has(extname(filename).toLowerCase())) {
      if (info.size > 10 * 1024 * 1024) throw new Error('Image artifact exceeds the 10 MiB read limit.');
      return { content: [{ type: 'image', data: (await readFile(path)).toString('base64'), mimeType: imageTypes.get(extname(filename).toLowerCase()) }] };
    }
    if (info.size > 1024 * 1024) throw new Error('Text artifact exceeds the 1 MiB read limit.');
    return { content: [{ type: 'text', text: await readFile(path, 'utf8') }] };
  }

  async finalizeReviewRun({ project_id: projectId, review_id: reviewId, status, summary }) {
    const profile = this.project(projectId);
    if (!['passed', 'needs_work', 'blocked'].includes(status)) throw new Error('status must be passed, needs_work, or blocked.');
    if (typeof summary !== 'string' || summary.length > 10_000) throw new Error('summary must be at most 10,000 characters.');
    const directory = await this.getReviewDirectory(profile, reviewId);
    await this.saveTextArtifact(profile, reviewId, 'summary.md', summary, 'summary');
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.status = status;
    manifest.finished_at = new Date().toISOString();
    await this.writeReviewFile(directory, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    return { project_id: projectId, review_id: reviewId, status, directory: relative(profile.root, directory) };
  }
}
