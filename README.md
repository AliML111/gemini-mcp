# Gemini panel → isolated Bash MCP

This proof of concept connects Gemini Apps to a local Streamable HTTP MCP server. It exposes three tools:

- `run_sandbox_bash` runs arbitrary Bash text in a fresh disposable gVisor container.
- `create_sandbox_workspace` creates a temporary private workspace for multi-step commands.
- `close_sandbox_workspace` immediately removes that workspace.

## Isolation model

The server only talks to a dedicated **rootless Docker daemon** at the current user's Docker socket. It refuses to start unless that daemon reports rootless mode, seccomp, gVisor, and the expected systemd cgroup limits. The existing rootful Docker daemon is not used.

Each command runs with no network, no host mounts, a read-only root filesystem, UID 10001, no Linux capabilities, `no-new-privileges`, the Docker default seccomp profile, and 16 MiB tmpfs mounts for `/tmp` and `/workspace`. Each gVisor sandbox process runs inside its own user-systemd scope capped at 256 MiB memory, no swap, 0.25 CPU, and 64 host tasks. A command is limited to 5 seconds, 1,000 input bytes, and 64 KiB output. At most two commands or two persistent workspaces can exist at once. Workspaces expire after 15 minutes idle or 60 minutes total.

The installed gVisor release needs `--ignore-cgroups` to start under this rootless Docker setup. The runtime wrapper therefore launches each `runsc` invocation inside a separate user-systemd scope; the Linux kernel enforces the scope's CPU, memory, swap, and host-task limits. The MCP server starts only after a live probe confirms the requested settings in that container's actual cgroup. The aggregate sandbox slice, which contains the Docker service and all sandbox scopes, is also constrained:

- 1.5 GiB memory, no swap
- 100% of one CPU
- 512 tasks total across the daemon and all sandboxes

The 64-task cap applies to host tasks in the gVisor scope; it is not a direct count of guest PIDs. gVisor documents that host cgroups can restrict a sandbox, but it does not enforce resource limits between competing guest processes inside one sandbox. The shared slice also caps total resource use across containers, and the MCP server refuses to start if slice, service, or per-container cgroup values are missing or different.

Rootless Docker does not support AppArmor. gVisor and Docker's default seccomp profile provide additional syscall isolation, but this remains a container sandbox on the host kernel, not a VM. Use a disposable VM for workloads that need a stronger boundary.

## Build, run, and verify

Requirements: Linux with a user systemd session, Node.js, npm, rootless Docker with cgroup v2, and gVisor installed as the `runsc` Docker runtime. The sandbox base image is pinned by digest in `sandbox/Dockerfile`.

Configure a user-systemd slice at `~/.config/systemd/user/app-gemini-mcp-sandbox.slice`:

```ini
[Slice]
CPUQuota=100%
MemoryMax=1536M
MemorySwapMax=0
TasksMax=512
```

Put the Docker service and its runsc scopes inside that slice. Add these lines to `~/.config/systemd/user/docker.service.d/sandbox-resource-limits.conf`, preserving any other settings already there:

```ini
[Service]
Slice=app-gemini-mcp-sandbox.slice
CPUQuota=100%
MemoryMax=768M
MemorySwapMax=0
TasksMax=256
Environment=GEMINI_MCP_RUNSC_BINARY=/absolute/path/to/runsc
Environment=GEMINI_MCP_SANDBOX_SLICE=app-gemini-mcp-sandbox.slice
```

In the dedicated rootless Docker daemon's `daemon.json`, configure `runsc` to use the wrapper from this repository. Preserve any unrelated daemon settings:

```json
{
  "runtimes": {
    "runsc": {
      "path": "/absolute/path/to/gemini-mcp/scripts/runsc-scope-wrapper.sh",
      "runtimeArgs": []
    }
  }
}
```

Reload the user manager and restart the dedicated daemon, then build and start the MCP server:

```bash
systemctl --user daemon-reload
systemctl --user restart docker.service
npm ci
npm run sandbox:build
npm start
```

The image build uses the rootless daemon. Runtime sandboxes always use `--network=none`. The MCP server binds only to `127.0.0.1:8787`; the endpoint is `/mcp`.

In another terminal, run the MCP protocol and isolation checks:

```bash
npm run smoke
```

The startup probe and smoke checks verify the rootless/gVisor backend, actual per-container scope caps, aggregate slice and service caps, filesystem and network isolation, temporary workspace lifecycle, output and timeout handling, cleanup, and concurrency limits.

## Gemini connection

Gemini Apps → Customize → Connected apps → **Create custom app** accepts an MCP HTTPS endpoint. For a short local experiment, a Cloudflare Quick Tunnel can provide one:

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787 --http-host-header 127.0.0.1:8787
```

Use the printed `https://…trycloudflare.com/mcp` URL, then stop the tunnel when finished. The temporary URL is the only access control in this setup: anyone who learns it can invoke the tools while it is running. Do not use this unauthenticated mode for a persistent endpoint. Gemini documents OAuth for custom MCP apps; Google does not document a generic static bearer-header setting. Add OAuth before keeping the connector available.

## Files

- `src/server.mjs` — MCP server, sandbox lifecycle, and fail-closed backend checks.
- `sandbox/Dockerfile` — pinned sandbox image definition.
- `scripts/sandbox-docker.mjs` — directs image builds to the dedicated rootless daemon.
- `scripts/runsc-scope-wrapper.sh` — launches each gVisor runtime process inside its own resource-limited user-systemd scope.
- `scripts/smoke.mjs` — MCP, isolation, lifecycle, and resource-cap checks.
