# Gemini panel → local command MCP

This proof of concept connects Gemini Apps to local tools through MCP. Gemini remains the agent and model; this project provides the local capabilities. Backends are selected at startup and host shell executables are detected before their tools are exposed. The default remains the managed Docker backend.

- `run_sandbox_bash` runs one Bash command in a fresh disposable gVisor container. Network access is disabled by default; `internet_access: true` opts into the rootless Docker bridge network.
- `run_sandbox_session` runs up to four commands in the same temporary workspace and returns structured results. `lifecycle: "ephemeral"` deletes after the batch; `"conversation"` retains it for 15 minutes idle/60 minutes total; `"task"` retains it for 30 minutes idle/4 hours total. Reuse the returned `session_id`; the server handles expiry and deletion.
- `run_host_commands` is available only when `bash` and/or `powershell` is explicitly selected at startup and detected. It runs directly on the host with the MCP server user's permissions; it is not sandboxed.
- `list_files`, `read_file`, `search_files`, `write_file`, and `edit_file` are available only when `filesystem` is selected. They are restricted to configured roots, defaulting to the project directory.
- Browser control is available as a separate Playwright MCP connector. Gemini can use both connectors in the same panel; the browser server owns its browser lifecycle and session state.
- The optional `project` backend runs configured web-project checks and previews inside managed gVisor sessions. Project paths and commands are explicitly configured by the MCP server administrator; the backend is not enabled by default.

All requests to the `/mcp` endpoint require OAuth 2.1 authorization code flow with PKCE. The server requires the exact public HTTPS MCP URL and an administrator-held access password at startup; Gemini's OAuth authorization page asks for that password before issuing tokens. Dynamic client registration and protected-resource metadata are enabled. OAuth client registrations and tokens are held in memory, so restarting the server requires reconnecting the Gemini custom app.

## Select backends at startup

Set `MCP_BACKENDS` to a comma-separated allowlist. The server probes selected host shell executables and exposes only the backends it finds. A missing host shell is skipped; selecting Docker still requires all rootless/gVisor/systemd checks to pass. Filesystem and project access are explicit backends and are not enabled by default. The project backend requires both `docker` and a JSON `MCP_PROJECTS_JSON` allowlist.

Before starting the server, set `MCP_PUBLIC_URL` to the exact HTTPS URL Gemini will use, including `/mcp`, and set a random password of at least 32 bytes:

```bash
export MCP_PUBLIC_URL='https://your-public-host.example/mcp'
export MCP_AUTH_PASSWORD="$(openssl rand -hex 32)"
```

Keep the password private. Gemini's OAuth flow presents a server login page where you enter it; the MCP route rejects missing, expired, wrongly scoped, and wrong-resource bearer tokens. The server refuses to start if either setting is missing, the URL is not HTTPS, or its path does not match `MCP_PATH`.

```bash
# Default: managed gVisor Docker only
npm start

# Direct local Bash only (Linux/macOS, or Bash installed on Windows)
MCP_BACKENDS=bash npm start

# Bash and PowerShell when both are installed
MCP_BACKENDS=bash,powershell npm start

# Project file tools only (defaults to this repository as the filesystem root)
MCP_BACKENDS=filesystem npm start

# Keep Docker and add detected host shells
MCP_BACKENDS=docker,bash,powershell npm start

# Combine isolated commands, file tools, and a detected local shell
MCP_BACKENDS=docker,filesystem,bash npm start

# Add the opt-in project build/preview workflow (requires MCP_PROJECTS_JSON)
MCP_BACKENDS=docker,project npm start
```

To add more file roots, set `MCP_FILESYSTEM_ROOTS` to a path-delimited list of absolute directories (`:` on Linux/macOS, `;` on Windows). For example:

```bash
MCP_BACKENDS=filesystem MCP_FILESYSTEM_ROOTS="$PWD:/home/ali/Documents/notes" npm start
```

The file tools read UTF-8 text, cap each file read at 5 MiB and each response at 64 KiB, and cap writes/edits at 128 KiB. Search skips `.git`, `node_modules`, `vendor`, `dist`, and `build`, and scans at most 2,000 files. `edit_file` only replaces one unique exact passage. Writes are limited to an existing directory under a configured root. These are host filesystem tools; enabling them grants Gemini read or write access to the selected roots, so choose roots deliberately.

In PowerShell on Windows, for example:

```powershell
$env:MCP_BACKENDS = 'powershell'
npm start
```

PowerShell detection tries `pwsh`/`pwsh.exe` and then `powershell`/`powershell.exe`. Bash detection tries `bash` and `bash.exe`. The `run_host_commands` batch runs commands sequentially in fresh shell processes, so variables and `cd` changes do not carry between entries; files written to the selected working directory remain on the host. Host commands have a 5-second per-command timeout, at most four commands per call, 4,000 combined command bytes, and 64 KiB output cap. They run with the server user's full permissions. Any OAuth-authorized Gemini client can call this backend, so enable it only when you trust the people who can enter the server access password.

Docker lifecycle profiles are server-owned. Ephemeral batches use one temporary container and remove it automatically. Conversation and task containers persist only for their fixed TTL profile, with expiry tracked in SQLite; Gemini does not need container create, close, or cleanup tools.

## Isolation model

The Docker backend only talks to a dedicated **rootless Docker daemon** at the current user's Docker socket. It refuses to start unless that daemon reports rootless mode, seccomp, gVisor, and the expected systemd cgroup limits. The existing rootful Docker daemon is not used. The filesystem and direct host shell backends are separate host capabilities and are not protected by the container boundary.

Sandboxes have no host mounts, a read-only root filesystem, UID 10001, no Linux capabilities, `no-new-privileges`, the Docker default seccomp profile, and 16 MiB tmpfs mounts for `/tmp` and `/workspace`. Network access defaults to `--network=none`. Setting `internet_access: true` opts that container into the rootless Docker bridge network, which allows outbound access to destinations reachable from that network; it is not a destination allowlist and may reach host or LAN services that the rootless network exposes. No ports are published. Each gVisor sandbox process runs inside its own user-systemd scope capped at 256 MiB memory, no swap, 0.25 CPU, and 64 host tasks. A command is limited to 5 seconds and 1,000 input bytes. A session batch accepts up to four commands and 4,000 combined input bytes; tool output is capped at 64 KiB. At most two shell runs can execute concurrently, and at most two kept sessions can exist. Conversation sessions expire after 15 minutes idle or 60 minutes total; task sessions expire after 30 minutes idle or 4 hours total. SQLite tracks each session's lifecycle and network setting across server restarts (workspace files remain in container tmpfs, not in SQLite).

The installed gVisor release needs `--ignore-cgroups` to start under this rootless Docker setup. The runtime wrapper therefore launches each `runsc` invocation inside a separate user-systemd scope; the Linux kernel enforces the scope's CPU, memory, swap, and host-task limits. The MCP server starts only after a live probe confirms the requested settings in that container's actual cgroup. The aggregate sandbox slice, which contains the Docker service and all sandbox scopes, is also constrained:

- 1.5 GiB memory, no swap
- 100% of one CPU
- 512 tasks total across the daemon and all sandboxes

The 64-task cap applies to host tasks in the gVisor scope; it is not a direct count of guest PIDs. gVisor documents that host cgroups can restrict a sandbox, but it does not enforce resource limits between competing guest processes inside one sandbox. The shared slice also caps total resource use across containers, and the MCP server refuses to start if slice, service, or per-container cgroup values are missing or different.

Rootless Docker does not support AppArmor. gVisor and Docker's default seccomp profile provide additional syscall isolation, but this remains a container sandbox on the host kernel, not a VM. Use a disposable VM for workloads that need a stronger boundary.

## Build, run, and verify

Requirements for the MCP server: Node.js 22.13+ (Node 24+ recommended for built-in SQLite) and npm. The Docker backend additionally requires Linux with a user systemd session, rootless Docker with cgroup v2, and gVisor installed as the `runsc` Docker runtime. The optional project backend also uses the `runsc-project` runtime, which has a separate 512 MiB/0.5 CPU/128 task scope. The sandbox base image is pinned by digest in `sandbox/Dockerfile`. Host shell backends do not require Docker.

On Ubuntu or Debian, install and configure the host requirements with:

```bash
./scripts/install-requirements.sh
```

The script installs `uidmap` if needed, downloads a versioned gVisor release and verifies its SHA-512 checksum, then configures and starts a dedicated rootless Docker user service. It preserves the current Docker CLI context and system-wide Docker daemon, and keeps unrelated settings when adding the `runsc` and `runsc-project` runtimes. Set `GVISOR_VERSION` to select another official release.

The following settings are installed by the script and can also be applied manually.

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

The image build uses the rootless daemon and includes Node.js/npm for project checks. Runtime sandboxes use `--network=none` by default; only an explicit `internet_access: true` selects `--network=bridge`. The MCP server binds only to `127.0.0.1:8787`; the endpoint is `/mcp`.

### Project build, preview, and review workflow

The `project` backend is opt-in and runs only projects listed in `MCP_PROJECTS_JSON`. Each profile has a short alias, an absolute project root, named commands, and an optional preview command/port. Example:

```bash
export MCP_PROJECTS_JSON='[{"id":"shop","name":"Shop UI","root":"/home/ali/projects/shop","commands":{"install":"npm ci","build":"npm run build","test":"npm test","lint":"npm run lint"},"preview":{"command":"npm run dev -- --host 0.0.0.0 --port 5173","port":5173}}]'
MCP_BACKENDS=docker,project npm start
```

Only aliases are returned to Gemini; absolute host paths stay server-side. Project sessions snapshot source into gVisor with no host mounts. The snapshot excludes `.git`, `node_modules`, `.env*` (except `.env.example`), build output, caches, common credential files, and symlinks. Traversal counts every directory entry (including excluded files, symlinks, and empty directories), and is limited to 30,000 entries, depth 64, 30,000 files, and 256 MiB. The session uses a 384 MiB tmpfs workspace, 512 MiB memory, 0.5 CPU, 128 tasks, and a 30-minute idle/2-hour maximum lifetime. Build outputs and installed dependencies persist between check and preview calls, then disappear when the session is removed.

Network mode is fixed when the project session starts. The default is an internal Docker network with outbound access disabled. The MCP server rejects `internet_access: true` unless its administrator starts it with `MCP_PROJECT_ALLOW_NETWORK=true`; that setting enables callers to request project network access. This rootless Docker setup cannot publish ports from the internal network, so dependency downloads and browser previews require that server-side opt-in and a session created with `internet_access: true`. The bridge may reach host/LAN services visible to Docker, and remains enabled for the session. When enabled, the preview port is published to a random `127.0.0.1` port for the local Playwright MCP connector; it is not published on a public interface. A preview process can be stopped separately, and the session can be removed explicitly or by TTL.

The tool sequence is: `create_review_run`, `start_project_session`, `run_project_checks` (for example `install`, `build`, `test`), `get_project_diff`, `start_project_preview`, then browser checks through Playwright. Save the browser report with `save_review_artifact`; call `browser_take_screenshot` without a filename to save an automatically named image into Playwright's configured output directory, then copy it with `save_review_screenshot` using the returned image filename. Update checklist progress with `update_review_checklist`, then finish with `finalize_review_run`. Review files are written under `.gemini-mcp/reviews/<review_id>/` inside the configured project root; they contain the plan, checklist, Git diff, command results, preview details, browser report, and screenshots. `read_review_artifact` returns saved screenshots as image content.

Use a project backend only with trusted code. Build, install, and preview scripts run in gVisor as the non-root container user. Enabling session network access allows those scripts to make outbound and bridge-reachable network requests. The project backend does not run host shell commands or mount project directories into the container.

## Browser connector

Use Microsoft's [Playwright MCP server](https://github.com/microsoft/playwright-mcp) as a second custom MCP app in Gemini. It provides browser navigation, accessibility snapshots, clicking, typing, and other browser tools; Gemini continues to plan and call tools. Its default launches a separate persistent browser profile. To control existing Chrome tabs and their signed-in state, install the Playwright browser extension and start it with `--extension`:

```bash
# Temporary headless browser session used for the current Gemini connector
npx -y @playwright/mcp@latest --headless --isolated --port 8931 --host 127.0.0.1

# Or use a separate headed browser profile
npx -y @playwright/mcp@latest --port 8931 --host 127.0.0.1

# Or attach to the browser where the Playwright extension is installed
npx -y @playwright/mcp@latest --port 8931 --host 127.0.0.1 --extension
```

If Gemini requires a public HTTPS URL for a remote custom app, start a temporary Quick Tunnel for the browser service in another terminal:

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8931 --http-host-header 127.0.0.1:8931
```

Add the printed `https://…trycloudflare.com/mcp` URL as a second custom app in Gemini. Stop both the browser MCP server and tunnel when done. A Quick Tunnel URL is a bearer secret, not authentication; anyone who learns it can control that browser session. The browser extension can expose pages where the user is signed in, so do not use an unauthenticated public tunnel for persistent access. Playwright also documents that its MCP server is not itself a security boundary.

Add `gemini-skill/SKILL.md` as a reusable skill in Gemini to teach it how to choose between the file tools, the Docker or host shell backend, and the Playwright browser connector.

With the server running and `MCP_PUBLIC_URL` plus `MCP_AUTH_PASSWORD` set in this shell, run the MCP protocol and isolation checks. The smoke script creates a temporary OAuth client and obtains a token using the configured password:

```bash
npm run smoke
```

For tests that do **not** require Docker or Gemini, run `npm test` (uses Node's built-in test runner and a fake Docker backend).

### Local SQLite workspace manager

The workspace registry is stored at `${XDG_STATE_HOME:-$HOME/.local/state}/gemini-mcp/sandboxes.sqlite` by default. Override with an **absolute** path, e.g.:

```bash
export SANDBOX_STATE_DB="$HOME/.local/state/gemini-mcp/sandboxes.sqlite"
```

Only one MCP server process should use a registry and dedicated Docker daemon at a time. The registry records session ID, Docker identity, timestamps, lifecycle profile, network setting, and status (`creating`, `ready`, `busy`, `deleting`); it does **not** store command contents, agent conversations, API keys, or workspace files. No database service, Python CLI, persistent disk volume, XFS quota configuration, or LLM model gateway is required.

On restart, the manager checks container labels, identity, and isolation configuration before reusing live workspaces. It removes expired containers, orphaned managed containers, and failed one-shot command containers. A workspace interrupted while running a command is deliberately discarded rather than resumed in an unknown state. A clean restart preserves idle workspaces until their original expiration; restarting never extends their maximum lifetime. Workspace files are tmpfs-only and disappear when the container is removed.

When `docker rm` fails, the SQLite record stays in `deleting` state for a later retry. Periodic cleanup checks every 30 seconds. The default `--network=none`, explicit opt-in bridge mode, read-only root, 16 MiB tmpfs, resource caps, and gVisor startup security probe are enforced by the server. The Docker tools do not grant agents host shell access, Docker API access, or control over other containers; direct host shell access is a separate opt-in backend.

**Migration from AX Lite Phases 1–5:** Stop the old services and remove the changes made by the Phase 5 *cumulative* patch before applying this focused patch. Make sure all changes from that previous patch are uncommitted and exactly match the cumulative patch before using `git apply -R`; do not use `git reset --hard` or `git clean -fd` when unrelated changes exist. Legacy AX Lite Docker volumes and state are not adopted or deleted by this manager. Review any old containers and volumes separately.

The startup probe and smoke checks verify the rootless/gVisor backend, actual per-container scope caps, aggregate slice and service caps, filesystem and network isolation, temporary workspace lifecycle, output and timeout handling, cleanup, and concurrency limits.

## Gemini connection

Gemini Apps → Customize → Connected apps → **Create custom app** accepts an MCP HTTPS endpoint. For a short local experiment, a Cloudflare Quick Tunnel can provide one:

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787 --http-host-header 127.0.0.1:8787
```

Leave the tunnel running while testing. Set `MCP_PUBLIC_URL` to the printed URL plus `/mcp`, generate `MCP_AUTH_PASSWORD`, and restart the MCP server with those values before connecting Gemini. The OAuth flow opens a password page; enter the server password there. The OAuth provider implements Dynamic Client Registration, authorization code with PKCE, scoped resource-bound bearer tokens, refresh-token rotation, and protected-resource metadata, following Google's [OAuth integration guide](https://developers.google.com/connected-apps/mcp/oauth). Quick Tunnel hostnames change when restarted, so a new hostname requires updating `MCP_PUBLIC_URL`, restarting this server, and reconnecting the custom app.

The authorization server keeps clients and tokens in memory. Restarting the MCP process invalidates existing tokens and registered client IDs, so reconnect the custom app after a restart. A Quick Tunnel URL is public and can expose the login page, but calls to `/mcp` still require a valid token issued after password authorization. Host-shell tools execute arbitrary commands with the server user's permissions; enable them only for trusted Gemini users.

## Antigravity-inspired split

The target is Gemini Web as the agent, with local capabilities exposed through MCP. The stack combines this project's optional Docker, host shell, and scoped filesystem tools with a browser MCP connector. Gemini handles planning, skills, connector selection, and conversation; the MCP servers execute the selected local operations. This does not call the Gemini API or rebuild Antigravity's agent runtime, authentication, or authorization system.

### Gemini skill and approvals

`gemini-skill/SKILL.md` is the reusable skill source. Gemini Apps supports skills in its web panel; the active Gemini account now has an `isolated-bash-mcp` skill with matching instructions. To add it to another account, open **Customize → Skills** and create it manually or upload the `SKILL.md` file.

Approval preferences belong to Gemini, not the MCP protocol. Google documents an **Always allow** permission for connected-app actions, but the active custom MCP app's details page currently lists only its available actions and exposes no permission dropdown. If Gemini offers **Always allow** in the tool approval flow or app settings, it can be selected there; this server cannot create or force that control. The Bash tool remains marked destructive because it accepts arbitrary commands, even though they run inside the isolated sandbox.

## Files

- `src/server.mjs` — MCP server and selectable Docker/Bash/PowerShell/filesystem/project backends.
- `src/project-workflow.mjs` — configured project snapshots, isolated checks, preview sessions, and review artifacts.
- `src/filesystem-backend.mjs` — root-scoped local file listing, reading, search, writing, and exact-passage edits.
- `src/sandbox-manager.mjs` — focused SQLite workspace lifecycle, TTL cleanup, and Docker reconciliation.
- `test/sandbox-manager.test.mjs` — unit tests without Docker.
- `sandbox/Dockerfile` — pinned sandbox image definition.
- `scripts/sandbox-docker.mjs` — directs image builds to the dedicated rootless daemon.
- `scripts/runsc-scope-wrapper.sh` — launches each gVisor runtime process inside its own resource-limited user-systemd scope.
- `scripts/runsc-project-scope-wrapper.sh` — applies a separate 512 MiB gVisor scope for project builds and previews.
- `scripts/install-requirements.sh` — installs host prerequisites and configures the dedicated rootless Docker/gVisor backend.
- `scripts/smoke.mjs` — MCP, isolation, lifecycle, and resource-cap checks.
