import { childEnvironment } from './child-environment.mjs';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;

export function createWslBackend(distribution) {
  if (process.platform !== 'win32') throw new Error('WSL backends require a Windows gateway.');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(distribution ?? '')) {
    throw new Error('Set MCP_WSL_DISTRO to the name of an installed WSL distribution.');
  }

  const invoke = (args, timeout = 10_000, input) => {
    const processResult = execFileAsync('wsl.exe', [
      '--distribution', distribution, '--cd', '~', '--exec', ...args,
    ], { env: childEnvironment(), windowsHide: true, timeout, maxBuffer: 64 * 1024, encoding: 'utf8' });
    if (input !== undefined) {
      processResult.child.stdin.on('error', () => {});
      processResult.child.stdin.end(input, 'utf8');
    }
    return processResult;
  };

  const docker = (args, timeout) => invoke(['docker', '--host', 'unix:///var/run/docker.sock', ...args], timeout);
  let activeShellRuns = 0;
  let activeContainers = 0;
  return {
    async probeShell() {
      await invoke(['/usr/bin/timeout', '2s', '/bin/bash', '--noprofile', '--norc', '-c', 'true']);
    },
    async runShell(commands, { parallel = false, timeoutSeconds = 10 } = {}) {
      const slots = parallel ? commands.length : 1;
      if (activeShellRuns + slots > 4) throw new Error('WSL command runner is at capacity. Retry after another run finishes.');
      activeShellRuns += slots;
      const runOne = async (command, index) => {
        const result = { index: index + 1, exit_code: 0, timed_out: false, stdout: '', stderr: '', output_truncated: false };
        try {
          const output = await invoke([
            '/usr/bin/timeout', '--kill-after=1s', `${timeoutSeconds}s`, '/bin/bash', '--noprofile', '--norc', '-s',
          ], (timeoutSeconds + 5) * 1_000, command);
          return { ...result, ...output };
        } catch (error) {
          const truncated = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          const timedOut = !truncated && (error.code === 124 || error.killed === true);
          return {
            ...result,
            exit_code: timedOut ? 124 : Number.isInteger(error.code) ? error.code : 1,
            timed_out: timedOut,
            stdout: error.stdout ?? '',
            stderr: error.stderr || (timedOut ? 'WSL command exceeded its time limit.' : truncated ? 'WSL command exceeded its output limit.' : 'WSL command failed to start or complete.'),
            output_truncated: truncated,
          };
        }
      };
      try {
        if (parallel) return await Promise.all(commands.map(runOne));
        const results = [];
        for (const [index, command] of commands.entries()) results.push(await runOne(command, index));
        return results;
      } finally {
        activeShellRuns -= slots;
      }
    },
    async probeDocker(image) {
      if (!imageIdPattern.test(image ?? '')) throw new Error('Set MCP_WSL_DOCKER_IMAGE to an approved local image ID (sha256:…).');
      const { stdout } = await docker(['version', '--format', '{{.Server.Os}}']);
      if (stdout.trim() !== 'linux') throw new Error('The selected WSL distribution must have access to a Linux Docker engine.');
      const metadata = await docker(['image', 'inspect', '--format', '{{.Id}} {{json .Config.Volumes}}', image]);
      if (metadata.stdout.trim() !== `${image} null` && metadata.stdout.trim() !== `${image} {}`) {
        throw new Error('The approved Docker image must be present locally and declare no volumes.');
      }
    },
    async runContainer(image) {
      if (activeContainers >= 2) throw new Error('WSL container runner is at capacity. Retry after another run finishes.');
      activeContainers += 1;
      const name = `gemini-mcp-wsl-${randomUUID()}`;
      try {
        await docker(['create', '--name', name, '--pull=never', '--network=none',
          '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
          '--memory=256m', '--memory-swap=256m', '--cpus=0.5', '--pids-limit=64', '--no-healthcheck', '--init', '--log-driver=none', '--ulimit=nofile=256:256', image]);
        const { stdout, stderr } = await docker(['start', '--attach', name], 20_000);
        return { stdout, stderr };
      } catch {
        throw new Error('The approved WSL container failed to run or exceeded its time or output limit.');
      } finally {
        try {
          await docker(['rm', '--force', '--volumes', name]);
        } catch (error) {
          if (!/no such container/i.test(error.stderr ?? '')) {
            console.error(`Could not remove WSL container ${name}. Inspect it on the configured Docker engine.`);
          }
        } finally {
          activeContainers -= 1;
        }
      }
    },
  };
}
