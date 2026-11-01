#!/bin/sh
set -eu

runtime_uid="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${runtime_uid}}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

runsc_binary="${GEMINI_MCP_RUNSC_BINARY:-/usr/bin/runsc}"
sandbox_slice="${GEMINI_MCP_SANDBOX_SLICE:-app-gemini-mcp-sandbox.slice}"

exec /usr/bin/systemd-run \
  --quiet \
  --user \
  --scope \
  --slice="${sandbox_slice}" \
  --property=CPUQuota=25% \
  --property=MemoryMax=256M \
  --property=MemorySwapMax=0 \
  --property=TasksMax=64 \
  -- \
  "${runsc_binary}" --ignore-cgroups "$@"
