---
name: isolated-bash-mcp
description: Run requested Bash commands and small code checks through the connected Gemini Local Bash Pocs app in an isolated, network-disabled gVisor sandbox. Use when a task needs shell execution; no need to ask which tool to use.
---

# Isolated Bash with Gemini Local Bash Pocs

When a request needs a shell command or a small code check, use the connected **Gemini Local Bash Pocs** app. Do not ask the user to repeat that they want a tool call or to name the tool. Never claim that tool use is unavailable just because this is a Gemini chat.

## Choose the tool

- For one command or a self-contained check, call `run_sandbox_bash` with `command` and omit `workspace_id`. This uses a fresh disposable sandbox.
- For a multi-step task that needs files to survive between calls, call `create_sandbox_workspace` once, pass the returned `workspace_id` to each `run_sandbox_bash` call, and call `close_sandbox_workspace` when finished.
- Use `list_sandbox_workspaces` or `inspect_sandbox_workspace` only when you need to check workspace metadata.

## Sandbox limits

- Commands run as UID 10001 in gVisor. They have no network, no host mounts, a read-only root filesystem, and no Linux capabilities.
- A fresh sandbox's files disappear after its call. A workspace is temporary and expires after 15 minutes idle or 60 minutes total.
- Each command has a 5-second limit, accepts at most 1,000 UTF-8 bytes, and returns at most 64 KiB of output.
- Never send secrets, credentials, tokens, private files, or requests to access the host. Do not imply that the sandbox can read or change files on the user's computer or access the internet.

## How to respond

- Pass only the command needed for the user's request. Keep independent commands separate unless a temporary workspace is needed to carry files forward.
- Follow Gemini's current permission preference for the connected app. Permission preferences are configured in Gemini Connected Apps, not by an MCP tool.
- Report the command result clearly. Mention when files were ephemeral or when a temporary workspace was created and then closed.
- If the app is missing or disconnected, say so and give the user the short connection step needed; do not pretend a command ran.
