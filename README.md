# Gemini local MCP gateway

This project is a cross-platform MCP gateway for Gemini. It serves built-in capabilities plus one or more configured MCP subprocesses through a single OAuth-protected endpoint. Gemini remains the agent and model; this project owns the local capabilities, module lifecycle, tool allowlists, OAuth capability checks, and audit log.

- `run_sandbox_bash` runs one Bash command in a fresh disposable gVisor container. Network access is disabled by default; `internet_access: true` opts into the rootless Docker bridge network.
- `run_sandbox_session` runs up to four commands in the same temporary workspace and returns structured results. `lifecycle: "ephemeral"` deletes after the batch; `"conversation"` retains it for 15 minutes idle/60 minutes total; `"task"` retains it for 30 minutes idle/4 hours total. Reuse the returned `session_id`; the server handles expiry and deletion.
- `run_host_commands` is available only when `bash` and/or `powershell` is explicitly selected at startup and detected. It runs directly on the host with the MCP server user's permissions; it is not sandboxed.
- `list_files`, `read_file`, `search_files`, `write_file`, and `edit_file` are available only when `filesystem` is selected. They require explicitly configured roots outside the gateway repository.
- Existing Chrome/Edge tabs can be controlled by Microsoft's Playwright MCP browser extension, proxied through this gateway. The extension attaches to a selected tab and keeps its browser session; it does not require launching a separate Playwright profile.
- On Windows, the default module is `windows-mcp-server` with only its `screen`, `interaction`, and `apps` toolsets. Shell, filesystem, registry, process, and system controls are excluded.
- The optional `project` backend runs configured web-project checks and previews inside managed gVisor sessions. Project paths and commands are explicitly configured by the MCP server administrator; the backend is not enabled by default.

All requests to `/mcp` require OAuth 2.1 authorization code flow with PKCE. The consent page is generated from the backends and module tools that are active and explicitly allowlisted; disabled feature flags and hidden tools do not appear as capabilities. Every `tools/call` request is checked against the capability grant and module tool allowlist. The server requires the exact public HTTPS MCP URL plus distinct passwords for OAuth approval and local dashboard administration. Dynamic client registration and protected-resource metadata are enabled. Each OAuth client can send 30 tool calls and 120 total MCP messages per minute. Batches are limited to 10 messages. Set `MCP_OAUTH_STATE_DB` to an absolute private SQLite file path to preserve OAuth clients and tokens across gateway restarts.

## Local admin dashboard and MCP modules

For a reverse proxy on loopback that overwrites forwarded client IP headers, set `MCP_TRUST_PROXY=loopback`. Leave it unset for direct access or a proxy that passes through untrusted forwarding headers. To restrict new OAuth registrations, set `MCP_REGISTRATION_TOKEN` to a separate secret of at least 32 UTF-8 bytes. Clients must then send it as a Bearer token on `POST /register`. Confirm that your client supports authenticated registration before enabling this setting.

Grant `gateway:status` to expose `mcp_status`. It reports enabled backends and the last known MCP module connection states. Project review packets belong to their OAuth client. Each project review directory is limited to 100 packets, and each packet to 20 entries. Archive older packets locally to free space. Review ownership is stored on disk. Configure OAuth persistence to preserve access for the same registered client across restarts.

The gateway advertises tools to each OAuth client based on its grants and checks those grants again on every call. Gemini chooses from the available tools. A command tool gives it general execution inside the selected environment, subject to that environment's permissions, resource limits, and network policy. A scoped tool grants only its defined operation. For example, `wsl:execute` grants general Bash execution as the WSL user, while `wsl:docker` grants one approved image's default workload.

The admin dashboard listens on `http://127.0.0.1:8788/` and is never routed through the public MCP tunnel. Sign in with `MCP_ADMIN_PASSWORD`. It shows backend and module status, discovers each module's tools, lets you enable individual tools and assign OAuth capabilities, and manages Markdown skills with `win32`, `linux`, `darwin`, or `all` platform targets. Changes to module and skill configuration apply without restarting the gateway. New capability grants still require a Gemini reconnect and authorization. The dashboard uses per-response Content Security Policy nonces, rejects cross-origin changes, and limits request bodies to 1 MiB.

The dashboard manages a local registry at `MCP_MODULES_FILE` (default `.gemini-mcp/modules.json`). Registry files are kept out of Git and protected by user-only ACLs on Windows or mode `0600` on POSIX. MCP subprocesses run with the server user's operating-system permissions; OAuth and per-tool allowlists control what Gemini can invoke, but they do not sandbox a subprocess. Each tool call has a 60-second timeout; a stalled child connection is closed and its tools are disabled until the module is reloaded. Add only MCP servers you trust.

Modules use stdio MCP transport and declare an id, display name, command, arguments, environment, supported platforms, capability labels, and per-tool policies. The default registry contains:

- `browser`: `npx -y @playwright/mcp@0.0.85 --extension --background`, enabled on Windows/Linux/macOS. The browser extension stays behind the app you are using and works with the selected existing tab. Background mode requires Playwright Extension 0.5.0 or later.
- `windows-desktop`: `windows-mcp-server.exe stdio --toolsets screen,interaction,apps`, enabled only on Windows. Its default toolsets provide desktop observation, UI interaction, and app/window control, without shell or filesystem toolsets.

Set `WINDOWS_MCP_SERVER_PATH` to the executable’s absolute path if it is outside `PATH`. The Windows adapter is downloaded from [deploymenttheory/windows-mcp-server](https://github.com/deploymenttheory/windows-mcp-server) as a Windows-only MCP subprocess. The gateway and registry format remain portable; each module declares which operating systems can start it. Skills enabled for the current platform are included in server instructions and offered as MCP prompts and resources.

### Windows desktop workflows

Enable the Windows desktop module and its tools in the dashboard. Grant desktop observation and interaction in Gemini. The helpers require `Snapshot` and the corresponding action tool to be enabled and granted.

- `desktop_act_and_observe` performs one accessibility action and returns a fresh snapshot.
- `desktop_run_steps` runs up to four actions in order and stops on a failure, unexpected focus change, or unmet expectation.

Use the exact foreground window title and optional process ID from `Snapshot`. Target controls by exact accessible name or automation ID. Each step can check for visible element text or an expected window title. Inspect the returned snapshot and whether an action was attempted before retrying.

## Select backends at startup

Run `npm ci` before starting the gateway.

Set `MCP_BACKENDS` to a comma-separated allowlist. The server probes selected host shell executables and exposes only the backends it finds. A missing host shell is skipped; selecting Docker still requires all rootless/gVisor/systemd checks to pass. Filesystem and project access are explicit backends and are not enabled by default. The project backend requires both `docker` and a JSON `MCP_PROJECTS_JSON` allowlist.

Before starting the server, set `MCP_PUBLIC_URL` to the exact HTTPS URL Gemini will use, including `/mcp`, and create separate random passwords of at least 32 bytes for OAuth approval and the local admin dashboard:

```bash
export MCP_PUBLIC_URL='https://your-public-host.example/mcp'
export MCP_AUTH_PASSWORD="$(openssl rand -hex 32)"
export MCP_ADMIN_PASSWORD="$(openssl rand -hex 32)"
```

Keep both passwords private and distinct. Enter `MCP_AUTH_PASSWORD` in Gemini's OAuth login page; use `MCP_ADMIN_PASSWORD` only for the local dashboard. The dashboard stays bound to loopback, and its password cannot authorize Gemini. The MCP route rejects missing, expired, wrongly scoped, and wrong-resource bearer tokens. The server refuses to start if the URL or either password is missing, the URL is not HTTPS, or its path does not match `MCP_PATH`.

```bash
# Default: managed gVisor Docker only
npm start

# Direct local Bash only (Linux/macOS, or Bash installed on Windows)
MCP_BACKENDS=bash npm start

# Bash and PowerShell when both are installed
MCP_BACKENDS=bash,powershell npm start

# Project file tools only (requires an explicit data directory outside this repository)
MCP_BACKENDS=filesystem MCP_FILESYSTEM_ROOTS=/home/ali/Documents/notes npm start

# Keep Docker and add detected host shells
MCP_BACKENDS=docker,bash,powershell npm start

# Combine isolated commands, file tools, and a detected local shell
MCP_BACKENDS=docker,filesystem,bash npm start

# Add the opt-in project build/preview workflow (requires MCP_PROJECTS_JSON)
MCP_BACKENDS=docker,project npm start
```

To add more file roots, set `MCP_FILESYSTEM_ROOTS` to a path-delimited list of absolute directories (`:` on Linux/macOS, `;` on Windows). For example:

```bash
MCP_BACKENDS=filesystem MCP_FILESYSTEM_ROOTS="/home/ali/Documents/notes" npm start
```

The file tools require explicitly configured absolute roots outside and not overlapping the MCP application directory. They protect `.git`, `.gemini-mcp`, and `node_modules` within those roots. They read UTF-8 text, cap each file read at 5 MiB and each response at 64 KiB, and cap writes/edits at 128 KiB. Search skips protected directories plus `vendor`, `dist`, and `build`, scans at most 2,000 files, and allows four concurrent scans. `edit_file` only replaces one unique exact passage. Writes are limited to an existing directory under a configured root. These are host filesystem tools; enabling them grants Gemini read or write access to the selected roots, so choose roots deliberately.

### WSL on Windows

Set `MCP_WSL_DISTRO` to an installed distribution from `wsl.exe --list --verbose`. Add either or both backends to `MCP_BACKENDS`:

- `wsl` exposes `run_wsl_command` with the separate `wsl:execute` grant. It requires Bash and GNU timeout in the distribution. Commands run with the WSL user's permissions and can access Windows files visible to that user.
- `wsl-docker` exposes `run_wsl_container` with the separate `wsl:docker` grant. It requires a Linux Docker engine reachable through `/var/run/docker.sock` in the distribution and `MCP_WSL_DOCKER_IMAGE` set to a full local `sha256:…` image ID. Choose a trusted image with a default command that can run as UID 65534 on a read-only filesystem. The tool runs that command without network, host mounts, or port publishing. It uses standard Docker isolation.

For example, to enable PowerShell and WSL shell access:

```powershell
$env:MCP_BACKENDS = 'powershell,wsl'
$env:MCP_WSL_DISTRO = 'Ubuntu'
npm start
```

The gateway exposes each WSL tool only if its startup check succeeds. Reauthorize Gemini to grant the new permission.

In PowerShell on Windows, for example:

```powershell
$env:MCP_BACKENDS = 'powershell'
npm start
```

When enabling filesystem tools on Windows, set `MCP_FILESYSTEM_ROOTS` to an absolute data directory such as `$env:USERPROFILE\Documents\GeminiFiles`; it must not overlap the MCP application directory.

PowerShell detection tries `pwsh`/`pwsh.exe` and then `powershell`/`powershell.exe`. Bash detection tries `bash` and `bash.exe`. Host and WSL shell calls accept up to four scripts of 8 KiB UTF-8 each. Each script starts a fresh process. Batches run sequentially by default, or concurrently with `parallel: true`. Set `timeout_seconds` from 1 to 60 per script (default 10). Timed-out calls include output captured before termination. The WSL tool accepts either `command` for one script or `commands` for a batch. They run with the server user's full permissions. The OAuth client must have the corresponding `host:execute` or `wsl:execute` grant.

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

## Existing-browser extension

The gateway runs Microsoft's [Playwright MCP server](https://github.com/microsoft/playwright-mcp) as a local stdio module and publishes only the tools checked in the dashboard. Install the [Playwright Extension](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md) in Chrome or Edge. Extension mode attaches to selected existing tabs and reuses that browser profile's signed-in sessions. Browser tools appear under names like `mcp_browser_browser_snapshot`; read, navigate, and interaction tools can be assigned separate OAuth capabilities.

```bash
npx -y @playwright/mcp@0.0.85 --extension --background
```

Do not point a public tunnel directly at the Playwright MCP process. The gateway keeps it on stdio and checks OAuth grants and tool allowlists before forwarding browser calls. The extension can access signed-in pages in the selected browser profile, so expose only the browser tools you need and approve the intended tab connection.

The dashboard also registers each enabled skill as an MCP prompt and `gemini-mcp://skills/<id>` resource for clients that support them.

With the server running and `MCP_PUBLIC_URL` plus `MCP_AUTH_PASSWORD` set in this shell, run the MCP protocol and isolation checks. The smoke script creates a temporary OAuth client and obtains a token using the configured password:

```bash
npm run smoke
```

For tests that do **not** require Docker or Gemini, run `npm test` (uses Node's built-in test runner and a fake Docker backend).

### MCP authorization policy

The OAuth password authenticates a person at consent time. The permissions selected on that page define the client’s grants. The consent form lists only capability groups backed by currently enabled tools and startup flags. For example, sandbox choices appear only when the Docker backend passes startup checks; filesystem choices appear only when filesystem tools are enabled; `project:network` appears only when the project network flag is on; module capabilities appear only when at least one matching tool is allowlisted.

- `sandbox:execute`: disposable or managed sandbox commands (selected by default when available)
- `sandbox:network`: opting those sandboxes into the rootless bridge network
- `filesystem:read` / `filesystem:write`: direct host filesystem access to configured roots
- `project:execute` / `project:network`: configured project workflow, with separate outbound network opt-in
- `host:execute`: arbitrary Bash/PowerShell with the MCP server user's host permissions
- `browser:observe`, `browser:navigate`, `browser:interact`: independently grant selected browser tools
- `desktop:observe`, `desktop:interact`, `desktop:apps`: independently grant selected Windows desktop tools

Each authenticated tool request is checked server-side against the capabilities granted to that OAuth client and the module's current per-tool allowlist. Refresh tokens preserve grants and cannot add new ones. A client must reconnect and reauthorize to gain a capability. Dynamic client registration allows 10 attempts per client IP per 15 minutes. The gateway retains a 200-client storage limit, and registrations expire after seven days. Failed consent passwords trigger a per-IP cooldown after three failures, starting at two seconds and doubling up to one minute. Configure trusted proxy forwarding for separate limits behind a tunnel. With MCP_OAUTH_STATE_DB configured, registrations and hashed token identifiers persist until expiry. The SQLite file contains client registration metadata and hashed bearer token identifiers. Store it outside the repository. In-progress authorization forms and codes still expire on restart. Keep the same public MCP URL and OAuth password to reuse the saved state.

**Compatibility:** existing Gemini clients must reconnect after installing this version. If a needed tool returns HTTP 403, reauthorize and select its capability; never disable authorization as a workaround. Be especially careful with host and filesystem write grants. Host-shell tools remain unsandboxed even when accessed through OAuth. These controls protect the MCP entrypoint, not commands manually run outside the server.

### Structured execution audit

The MCP server writes a JSON Lines audit by default to `$XDG_STATE_HOME/gemini-mcp/execution-audit.jsonl` (or `$HOME/.local/state/gemini-mcp/execution-audit.jsonl` when unset). Set `MCP_AUDIT_LOG` to an absolute path to use another destination.

Audit events include a correlation UUID, a truncated one-way client-ID fingerprint, tool name, capability, start/finish/denial, duration, network opt-in flag, batch size, and available exit/timeout status. Schema: `gemini-mcp.audit.v1`. **Raw commands, file paths, file contents, tool arguments, bearer tokens and tool output are not recorded.**

The server refuses to start without a private audit file (0600 on POSIX; on Windows its ACL is restricted to the current user, SYSTEM, and Administrators), and refuses a new tool invocation when the start event cannot be persisted. Start records are persisted before the action; finish records are queued off the response path and drained during shutdown. A write failure after command execution cannot undo the action. These JSONL records are operational audits, not a tamper-evident ledger. Keep logs private; establish retention and collection controls. The gateway rotates the audit at 16 MiB and keeps one previous file. It refuses new audited operations if the 256-entry write queue is full.

### SQLite single-instance ownership

The Docker workspace registry now acquires an exclusive kernel-backed `flock(1)` lock at `<SANDBOX_STATE_DB>.owner.lock` **before** opening the SQLite database or reconciling containers. A second process with the same state path fails startup. The lock is held by a helper process connected to the owner through stdin and automatically releases when its process exits, including after a crash.

**Never delete the lock file to free the registry.** The inode is intentionally persistent. The owner-lock helper requires Linux and util-linux `flock`. This is a single-host file lock, not a distributed lease: do not share the database on an unreliable filesystem or run multiple servers against the same Docker daemon with different registry paths.

### Local SQLite workspace manager

The workspace registry is stored at `${XDG_STATE_HOME:-$HOME/.local/state}/gemini-mcp/sandboxes.sqlite` by default. Override with an **absolute** path, e.g.:

```bash
export SANDBOX_STATE_DB="$HOME/.local/state/gemini-mcp/sandboxes.sqlite"
```

Only one MCP server process should use a registry and dedicated Docker daemon at a time. The registry records session ID, Docker identity, timestamps, lifecycle profile, network setting, and status (`creating`, `ready`, `busy`, `deleting`); it does **not** store command contents, agent conversations, API keys, or workspace files. No database service, Python CLI, persistent disk volume, XFS quota configuration, or LLM model gateway is required.

On restart, the manager checks container labels, identity, and isolation configuration before reusing live workspaces. It removes expired containers, orphaned managed containers, and failed one-shot command containers. A workspace interrupted while running a command is deliberately discarded rather than resumed in an unknown state. A clean restart preserves idle workspaces until their original expiration; restarting never extends their maximum lifetime. Workspace files are tmpfs-only and disappear when the container is removed.

When `docker rm` fails, the SQLite record stays in `deleting` state for a later retry. A tracked workspace with mismatched identity or isolation settings is quarantined and releases its workspace slot. The gateway retains the record and leaves the unverified container untouched. Periodic cleanup checks every 30 seconds. The default `--network=none`, explicit opt-in bridge mode, read-only root, 16 MiB tmpfs, resource caps, and gVisor startup security probe are enforced by the server. The Docker tools do not grant agents host shell access, Docker API access, or control over other containers; direct host shell access is a separate opt-in backend.

**Migration from AX Lite Phases 1–5:** Stop the old services and remove the changes made by the Phase 5 *cumulative* patch before applying this focused patch. Make sure all changes from that previous patch are uncommitted and exactly match the cumulative patch before using `git apply -R`; do not use `git reset --hard` or `git clean -fd` when unrelated changes exist. Legacy AX Lite Docker volumes and state are not adopted or deleted by this manager. Review any old containers and volumes separately.

The startup probe and smoke checks verify the rootless/gVisor backend, actual per-container scope caps, aggregate slice and service caps, filesystem and network isolation, temporary workspace lifecycle, output and timeout handling, cleanup, and concurrency limits.

## Gemini connection

In Gemini, open **Settings → Connected Apps → Custom apps** and add the MCP HTTPS endpoint. Each Google account completes its own link. If Gemini says account linking is required, reopen the connection in that account and finish the gateway consent redirect. For a short local experiment, a Cloudflare Quick Tunnel can provide one:

```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787 --http-host-header 127.0.0.1:8787
```

Leave the tunnel running while testing. Set `MCP_PUBLIC_URL` to the printed URL plus `/mcp`, generate distinct `MCP_AUTH_PASSWORD` and `MCP_ADMIN_PASSWORD` values, and restart the MCP server with those values before connecting Gemini. The OAuth flow opens a password page; enter the OAuth password there. The OAuth provider implements Dynamic Client Registration, authorization code with PKCE, scoped resource-bound bearer tokens, refresh-token rotation, and protected-resource metadata, following Google's [OAuth integration guide](https://developers.google.com/connected-apps/mcp/oauth). Quick Tunnels are for testing. A named tunnel can provide a stable hostname. Quick Tunnel hostnames change when restarted, so a new hostname requires updating `MCP_PUBLIC_URL`, restarting this server, and reconnecting the custom app.

Without MCP_OAUTH_STATE_DB, restarting the MCP process invalidates existing tokens and registered client IDs. With persistence enabled, use a stable public URL to preserve access across gateway restarts. A Quick Tunnel URL is public and can expose the login page, but calls to `/mcp` still require a valid token issued after password authorization. Host-shell tools execute arbitrary commands with the server user's permissions; enable them only for trusted Gemini users.

## Antigravity-inspired split

The target is Gemini Web as the agent, with local capabilities exposed through MCP. The stack combines this project's optional Docker, host shell, and scoped filesystem tools with a browser MCP connector. Gemini handles planning, skills, connector selection, and conversation; the MCP servers execute the selected local operations. This does not call the Gemini API or rebuild Antigravity's agent runtime, authentication, or authorization system.

### Gemini skill and approvals

`gemini-skill/SKILL.md` is the reusable skill source. To add the skill to a Gemini account, open **Customize → Skills** and create it manually or upload the `SKILL.md` file.

Approval preferences belong to Gemini, not the MCP protocol. Google documents an **Always allow** permission for connected-app actions, but the active custom MCP app's details page currently lists only its available actions and exposes no permission dropdown. If Gemini offers **Always allow** in the tool approval flow or app settings, it can be selected there; this server cannot create or force that control. The Bash tool remains marked destructive because it accepts arbitrary commands, even though they run inside the isolated sandbox.

## Files

- `src/server.mjs` — gateway startup, capability selection, and tool registration.
- `src/mcp-http-app.mjs` — MCP HTTP transport, request limits, and authorization checks.
- `src/mcp-oauth.mjs` and `src/oauth-state.mjs` — OAuth consent, registration, tokens, and optional SQLite persistence.
- `src/admin-dashboard.mjs` and `src/mcp-module-manager.mjs` — local configuration and child MCP lifecycle.
- `src/desktop-workflow.mjs` and `src/wsl-backend.mjs` — Windows desktop workflows and WSL tools.
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
