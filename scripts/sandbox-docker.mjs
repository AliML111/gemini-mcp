import { spawn } from 'node:child_process';

const dockerHost = process.env.SANDBOX_DOCKER_HOST
  ?? `unix://${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`}/docker.sock`;
const child = spawn('docker', ['--host', dockerHost, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(`Could not start Docker through the configured rootless socket ${dockerHost}: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
