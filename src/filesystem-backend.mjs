import { lstat, readFile as readFileAsync, readdir, realpath, rename, stat, unlink, writeFile as writeFileAsync } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const maxReadBytes = 5 * 1024 * 1024;
const maxReadOutputBytes = 64 * 1024;
const maxWriteBytes = 128 * 1024;
const maxSearchFileBytes = 1024 * 1024;
const maxSearchFiles = 2_000;
const maxSearchMatches = 50;
const skippedDirectories = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build']);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function isWithin(target, root) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

export async function initializeFilesystemBackend(configuredRoots = process.env.MCP_FILESYSTEM_ROOTS) {
  const candidates = configuredRoots
    ? configuredRoots.split(delimiter).map((value) => value.trim()).filter(Boolean)
    : [projectRoot];
  if (candidates.length === 0) throw new Error('MCP_FILESYSTEM_ROOTS must contain at least one directory.');

  const roots = [];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) throw new Error(`Filesystem root must be absolute: ${candidate}`);
    const canonical = await realpath(candidate);
    if (!(await stat(canonical)).isDirectory()) throw new Error(`Filesystem root must be a directory: ${candidate}`);
    if (!roots.includes(canonical)) roots.push(canonical);
  }
  return new FilesystemBackend(roots);
}

class FilesystemBackend {
  constructor(roots) {
    this.roots = roots;
  }

  async resolvePath(inputPath, { allowMissing = false } = {}) {
    if (!inputPath.trim()) throw new Error('path must not be empty.');
    const candidates = isAbsolute(inputPath)
      ? [resolve(inputPath)]
      : this.roots.map((root) => resolve(root, inputPath));
    let lastError;

    for (const candidate of candidates) {
      try {
        const canonical = await realpath(candidate);
        if (this.roots.some((root) => isWithin(canonical, root))) return canonical;
        throw new Error('path is outside the configured filesystem roots.');
      } catch (error) {
        if (error.message.includes('outside the configured')) throw error;
        lastError = error;
        if (!allowMissing || error.code !== 'ENOENT') continue;
        const parent = await realpath(join(candidate, '..')).catch(() => null);
        const root = this.roots.find((item) => parent && isWithin(parent, item));
        if (!root) continue;
        try {
          await lstat(candidate);
          throw new Error('Refusing to write through a symbolic link.');
        } catch (lstatError) {
          if (lstatError.code !== 'ENOENT') throw lstatError;
        }
        return candidate;
      }
    }

    if (lastError?.code === 'ENOENT') throw new Error(`Path does not exist inside the configured roots: ${inputPath}`);
    throw lastError ?? new Error(`Path is outside the configured filesystem roots: ${inputPath}`);
  }

  async listFiles(path = '.', limit = 200) {
    const directory = await this.resolvePath(path);
    if (!(await stat(directory)).isDirectory()) throw new Error('path must point to a directory.');
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const shown = entries.slice(0, limit).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
    }));
    return {
      path: directory,
      entries: shown,
      truncated: entries.length > shown.length,
      total_entries: entries.length,
    };
  }

  async readFile(path, startLine = 1, lineCount = 200) {
    const filePath = await this.resolvePath(path);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('path must point to a regular file.');
    if (info.size > maxReadBytes) throw new Error(`File is larger than the ${maxReadBytes}-byte read limit; use search_files or a shell tool to inspect it.`);
    const content = await readFileAsync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const slice = lines.slice(startLine - 1, startLine - 1 + lineCount);
    let output = slice.map((line, index) => `${String(startLine + index).padStart(5, ' ')}  ${line}`).join('\n');
    let truncated = startLine - 1 + lineCount < lines.length;
    if (Buffer.byteLength(output, 'utf8') > maxReadOutputBytes) {
      output = Buffer.from(output, 'utf8').subarray(0, maxReadOutputBytes).toString('utf8');
      truncated = true;
    }
    return { path: filePath, start_line: startLine, line_count: slice.length, total_lines: lines.length, truncated, content: output };
  }

  async searchFiles(query, path = '.', caseSensitive = false) {
    const searchRoot = await this.resolvePath(path);
    const rootInfo = await stat(searchRoot);
    if (!rootInfo.isDirectory()) throw new Error('search path must point to a directory.');
    const matches = [];
    let filesVisited = 0;
    let truncated = false;
    const needle = caseSensitive ? query : query.toLocaleLowerCase();

    const visit = async (directory) => {
      if (filesVisited >= maxSearchFiles || matches.length >= maxSearchMatches) {
        truncated = true;
        return;
      }
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (matches.length >= maxSearchMatches || filesVisited >= maxSearchFiles) {
          truncated = true;
          return;
        }
        if (entry.isSymbolicLink()) continue;
        const child = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!skippedDirectories.has(entry.name)) await visit(child);
          continue;
        }
        if (!entry.isFile()) continue;
        filesVisited += 1;
        let info;
        try { info = await stat(child); } catch { continue; }
        if (info.size > maxSearchFileBytes) continue;
        let text;
        try { text = await readFileAsync(child, 'utf8'); } catch { continue; }
        if (text.includes('\u0000')) continue;
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
          if (!line.includes(needle)) continue;
          matches.push({ path: child, line: index + 1, text: lines[index].slice(0, 500) });
          if (matches.length >= maxSearchMatches) {
            truncated = true;
            return;
          }
        }
      }
    };

    if (rootInfo.isDirectory()) await visit(searchRoot);
    return { query, path: searchRoot, files_visited: filesVisited, truncated, matches };
  }

  async writeFile(path, content) {
    if (Buffer.byteLength(content, 'utf8') > maxWriteBytes) throw new Error(`File content exceeds the ${maxWriteBytes}-byte write limit.`);
    const filePath = await this.resolvePath(path, { allowMissing: true });
    const parent = await realpath(join(filePath, '..'));
    if (!this.roots.some((root) => isWithin(parent, root))) throw new Error('path is outside the configured filesystem roots.');
    const current = await lstat(filePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (current?.isSymbolicLink()) throw new Error('Refusing to overwrite a symbolic link.');
    if (current && !current.isFile()) throw new Error('path must be a regular file or a new file in an existing directory.');
    const temporaryPath = join(parent, `.gemini-mcp-${randomUUID()}.tmp`);
    try {
      await writeFileAsync(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    return { path: filePath, bytes_written: Buffer.byteLength(content, 'utf8') };
  }

  async editFile(path, oldText, newText) {
    const filePath = await this.resolvePath(path);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('path must point to a regular file.');
    if (info.size > maxWriteBytes) throw new Error(`File is larger than the ${maxWriteBytes}-byte edit limit.`);
    const content = await readFileAsync(filePath, 'utf8');
    const first = content.indexOf(oldText);
    if (first < 0) throw new Error('old_text was not found; file was not changed.');
    if (content.indexOf(oldText, first + oldText.length) >= 0) throw new Error('old_text appears more than once; provide a unique larger snippet.');
    const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
    const result = await this.writeFile(filePath, updated);
    return { ...result, replacements: 1 };
  }
}
