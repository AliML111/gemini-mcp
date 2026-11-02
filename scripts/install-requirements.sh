#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
RUNSC_WRAPPER="${REPO_ROOT}/scripts/runsc-scope-wrapper.sh"
PROJECT_RUNSC_WRAPPER="${REPO_ROOT}/scripts/runsc-project-scope-wrapper.sh"
SANDBOX_SLICE="app-gemini-mcp-sandbox.slice"
SANDBOX_RUNSC_VERSION="${GVISOR_VERSION:-20261026.0}"
USER_ID="$(id -u)"
USER_NAME="$(id -un)"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${USER_ID}}"
CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
RUNSC_HOME="${HOME}/.local/lib/gemini-mcp/gvisor"
DOCKER_CONFIG_DIR="${CONFIG_HOME}/docker"
DOCKER_DAEMON_CONFIG="${DOCKER_CONFIG_DIR}/daemon.json"
USER_SYSTEMD_DIR="${CONFIG_HOME}/systemd/user"
DOCKER_DROPIN_DIR="${USER_SYSTEMD_DIR}/docker.service.d"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Linux ]] || fail 'This setup script supports Linux only.'
[[ "${USER_ID}" != 0 ]] || fail 'Run this script as your regular user, not with sudo.'
[[ -d "${RUNTIME_DIR}" && -w "${RUNTIME_DIR}" ]] || fail "The user runtime directory is not writable: ${RUNTIME_DIR}. Log in through a normal user systemd session and retry."
export XDG_RUNTIME_DIR="${RUNTIME_DIR}"
systemctl --user show-environment >/dev/null 2>&1 || fail 'A user systemd manager is required.'
[[ "$(stat -fc %T /sys/fs/cgroup)" == cgroup2fs ]] || fail 'cgroup v2 is required.'

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail 'Automatic package installation supports Ubuntu and Debian. Install the host prerequisites with your distribution package manager, then retry.' ;;
esac

node_version="$(node -p 'process.versions.node' 2>/dev/null)" || fail 'Node.js 22.13 or newer is required.'
IFS=. read -r node_major node_minor _ <<<"${node_version}"
if (( node_major < 22 || (node_major == 22 && node_minor < 13) )); then
  fail "Node.js 22.13 or newer is required; found ${node_version}."
fi
command -v npm >/dev/null 2>&1 || fail 'npm is required.'

for tool in docker dockerd-rootless.sh dockerd-rootless-setuptool.sh rootlesskit systemd-run node; do
  command -v "${tool}" >/dev/null 2>&1 || fail "Required command not found: ${tool}. Install Docker Engine with its rootless extras, then retry."
done

missing_packages=()
if ! command -v newuidmap >/dev/null 2>&1 || ! command -v newgidmap >/dev/null 2>&1; then missing_packages+=(uidmap); fi
if ! command -v curl >/dev/null 2>&1; then missing_packages+=(curl); fi
if ! command -v zstd >/dev/null 2>&1; then missing_packages+=(zstd); fi
if ! command -v sha512sum >/dev/null 2>&1; then missing_packages+=(coreutils); fi
if ! command -v tar >/dev/null 2>&1; then missing_packages+=(tar); fi
if ! command -v update-ca-certificates >/dev/null 2>&1; then missing_packages+=(ca-certificates); fi
if ((${#missing_packages[@]})); then
  command -v apt-get >/dev/null 2>&1 || fail "Install these host packages with your distribution package manager: ${missing_packages[*]}"
  say "Installing host packages: ${missing_packages[*]}"
  sudo apt-get update
  sudo apt-get install -y "${missing_packages[@]}"
fi

for tool in newuidmap newgidmap curl tar zstd sha512sum; do
  command -v "${tool}" >/dev/null 2>&1 || fail "Required command not found after package setup: ${tool}."
done

for subid_file in /etc/subuid /etc/subgid; do
  [[ -r "${subid_file}" ]] || fail "Required subordinate-ID file is missing: ${subid_file}"
  awk -F: -v name="${USER_NAME}" -v uid="${USER_ID}" '$1 == name || $1 == uid { if ($3 >= 65536) ok = 1 } END { exit !ok }' "${subid_file}" \
    || fail "${USER_NAME} needs a range of at least 65,536 subordinate IDs in ${subid_file}."
done

gvisor_arch="$(uname -m)"
case "${gvisor_arch}" in
  x86_64|aarch64) ;;
  *) fail "gVisor does not have a supported release archive for ${gvisor_arch}." ;;
esac
[[ "${SANDBOX_RUNSC_VERSION}" =~ ^[0-9]{8}\.[0-9]+$ ]] || fail 'GVISOR_VERSION must look like 20261026.0.'

cache_dir="${HOME}/.cache/gemini-mcp/gvisor/${SANDBOX_RUNSC_VERSION}"
install_dir="${RUNSC_HOME}/${SANDBOX_RUNSC_VERSION}"
archive="${cache_dir}/gvisor.tar.zstd"
checksum="${cache_dir}/gvisor.tar.zstd.sha512"
mkdir -p "${cache_dir}" "${RUNSC_HOME}"
if [[ ! -s "${archive}" || ! -s "${checksum}" ]]; then
  base_url="https://storage.googleapis.com/gvisor/releases/release/${SANDBOX_RUNSC_VERSION}/${gvisor_arch}"
  say "Downloading gVisor ${SANDBOX_RUNSC_VERSION} from the official release bucket."
  curl --fail --location --silent --show-error "${base_url}/gvisor.tar.zstd" --output "${archive}.partial"
  curl --fail --location --silent --show-error "${base_url}/gvisor.tar.zstd.sha512" --output "${checksum}.partial"
  mv -- "${archive}.partial" "${archive}"
  mv -- "${checksum}.partial" "${checksum}"
fi
(cd -- "${cache_dir}" && sha512sum --check "$(basename -- "${checksum}")") || fail 'The gVisor archive checksum did not match.'

if [[ ! -x "${install_dir}/runsc" ]]; then
  stage_dir="$(mktemp -d "${RUNSC_HOME}/.stage-${SANDBOX_RUNSC_VERSION}.XXXXXX")"
  trap 'rm -rf -- "${stage_dir}"' EXIT
  tar --zstd --extract --file "${archive}" --directory "${stage_dir}"
  extracted_version="$("${stage_dir}/runsc" --version | awk '/^runsc version / { print $3; exit }' | sed 's/^release-//')"
  [[ "${extracted_version}" == "${SANDBOX_RUNSC_VERSION}" ]] || fail "Expected gVisor ${SANDBOX_RUNSC_VERSION}, got ${extracted_version:-unknown}."
  [[ ! -e "${install_dir}" ]] || fail "The gVisor destination exists but is incomplete: ${install_dir}"
  mv -- "${stage_dir}" "${install_dir}"
  trap - EXIT
fi
[[ -x "${install_dir}/runsc" && -d "${install_dir}/gvisor-bin" ]] || fail "The gVisor install is incomplete: ${install_dir}"
runsc_binary="${install_dir}/runsc"

mkdir -p "${USER_SYSTEMD_DIR}" "${DOCKER_DROPIN_DIR}" "${DOCKER_CONFIG_DIR}"
slice_unit="${USER_SYSTEMD_DIR}/${SANDBOX_SLICE}"
if [[ ! -e "${slice_unit}" ]]; then
  slice_temp="$(mktemp "${USER_SYSTEMD_DIR}/.${SANDBOX_SLICE}.XXXXXX")"
  cat >"${slice_temp}" <<EOF
[Unit]
Description=Resource limits for the Gemini MCP sandbox daemon and gVisor scopes

[Slice]
CPUQuota=100%
MemoryMax=1536M
MemorySwapMax=0
TasksMax=512
EOF
  mv -- "${slice_temp}" "${slice_unit}"
else
  for setting in 'CPUQuota=100%' 'MemoryMax=1536M' 'MemorySwapMax=0' 'TasksMax=512'; do
    grep -Fqx "${setting}" "${slice_unit}" || fail "Existing ${slice_unit} must include ${setting}; it was left unchanged."
  done
fi

docker_dropin="${DOCKER_DROPIN_DIR}/90-gemini-mcp-sandbox.conf"
expected_dropin="$(mktemp "${DOCKER_DROPIN_DIR}/.gemini-mcp-sandbox.XXXXXX")"
legacy_dropin="$(mktemp "${DOCKER_DROPIN_DIR}/.gemini-mcp-sandbox-legacy.XXXXXX")"
cat >"${legacy_dropin}" <<EOF
[Service]
Slice=${SANDBOX_SLICE}
CPUQuota=100%
MemoryMax=768M
MemorySwapMax=0
TasksMax=256
Environment=GEMINI_MCP_RUNSC_BINARY=${runsc_binary}
Environment=GEMINI_MCP_SANDBOX_SLICE=${SANDBOX_SLICE}
EOF
cat >"${expected_dropin}" <<EOF
[Service]
Slice=${SANDBOX_SLICE}
CPUQuota=100%
MemoryMax=768M
MemorySwapMax=0
TasksMax=256
Environment=GEMINI_MCP_RUNSC_BINARY=${runsc_binary}
Environment=GEMINI_MCP_SANDBOX_SLICE=${SANDBOX_SLICE}
Environment=GEMINI_MCP_PROJECT_RUNSC_BINARY=${runsc_binary}
Environment=GEMINI_MCP_PROJECT_SANDBOX_SLICE=${SANDBOX_SLICE}
EOF
if [[ -e "${docker_dropin}" ]]; then
  if cmp -s "${expected_dropin}" "${docker_dropin}"; then
    rm -f -- "${expected_dropin}"
    rm -f -- "${legacy_dropin}"
  elif cmp -s "${legacy_dropin}" "${docker_dropin}"; then
    mv -- "${expected_dropin}" "${docker_dropin}"
    rm -f -- "${legacy_dropin}"
  else
    rm -f -- "${expected_dropin}" "${legacy_dropin}"
    fail "Existing ${docker_dropin} differs from the known sandbox setup; it was left unchanged."
  fi
else
  mv -- "${expected_dropin}" "${docker_dropin}"
  rm -f -- "${legacy_dropin}"
fi

node --input-type=module - "${DOCKER_DAEMON_CONFIG}" "${RUNSC_WRAPPER}" "${PROJECT_RUNSC_WRAPPER}" <<'NODE'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const [configPath, wrapperPath, projectWrapperPath] = process.argv.slice(2);
let config = {};
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${configPath}: ${error.message}`);
  }
}
if (!config || Array.isArray(config) || typeof config !== 'object') {
  throw new Error(`${configPath} must contain a JSON object.`);
}
config.runtimes ??= {};
if (Array.isArray(config.runtimes) || typeof config.runtimes !== 'object') {
  throw new Error(`${configPath}: "runtimes" must be a JSON object.`);
}
const existing = config.runtimes.runsc ?? {};
if (Array.isArray(existing) || typeof existing !== 'object') {
  throw new Error(`${configPath}: "runtimes.runsc" must be a JSON object.`);
}
const runtimeArgs = Array.isArray(existing.runtimeArgs) ? existing.runtimeArgs : [];
const existingProject = config.runtimes['runsc-project'] ?? {};
if (Array.isArray(existingProject) || typeof existingProject !== 'object') {
  throw new Error(`${configPath}: "runtimes.runsc-project" must be a JSON object.`);
}
if (existingProject.path && existingProject.path !== projectWrapperPath) {
  throw new Error(`${configPath}: "runtimes.runsc-project" is already configured to ${existingProject.path}; it was left unchanged.`);
}
const projectRuntimeArgs = Array.isArray(existingProject.runtimeArgs) ? existingProject.runtimeArgs : [];
const next = {
  ...config,
  runtimes: {
    ...config.runtimes,
    runsc: { ...existing, path: wrapperPath, runtimeArgs },
    'runsc-project': { ...existingProject, path: projectWrapperPath, runtimeArgs: projectRuntimeArgs },
  },
};
const serialized = `${JSON.stringify(next, null, 2)}\n`;
if (existsSync(configPath) && readFileSync(configPath, 'utf8') === serialized) process.exit(0);
if (existsSync(configPath)) {
  const backupPath = `${configPath}.backup-${new Date().toISOString().replaceAll(':', '-')}`;
  copyFileSync(configPath, backupPath);
  process.stderr.write(`Backed up existing Docker daemon config to ${backupPath}\n`);
}
const temporaryPath = `${configPath}.tmp-${process.pid}`;
writeFileSync(temporaryPath, serialized, { mode: 0o600 });
renameSync(temporaryPath, configPath);
NODE

previous_context="$(docker context show 2>/dev/null || true)"
restore_context() {
  local current_context
  current_context="$(docker context show 2>/dev/null || true)"
  if [[ -n "${previous_context}" && -n "${current_context}" && "${current_context}" != "${previous_context}" ]]; then
    docker context use "${previous_context}" >/dev/null 2>&1 || true
  fi
}
trap restore_context EXIT

systemctl --user daemon-reload
say 'Installing and starting the dedicated rootless Docker user service.'
dockerd-rootless-setuptool.sh install --force
say 'Restarting the rootless Docker user service to load the configured gVisor runtimes.'
systemctl --user restart docker.service
restore_context

docker_socket="unix://${RUNTIME_DIR}/docker.sock"
for attempt in {1..30}; do
  if docker --host "${docker_socket}" info >/dev/null 2>&1; then break; fi
  sleep 1
done
docker --host "${docker_socket}" info >/dev/null 2>&1 || fail "The rootless Docker daemon did not become ready at ${docker_socket}."

security_options="$(docker --host "${docker_socket}" info --format '{{json .SecurityOptions}}')"
[[ "${security_options}" == *'name=rootless'* ]] || fail 'The dedicated Docker daemon did not report rootless mode.'
runtime_info="$(docker --host "${docker_socket}" info --format '{{json .Runtimes}}')"
node --input-type=module - "${runtime_info}" "${RUNSC_WRAPPER}" "${PROJECT_RUNSC_WRAPPER}" <<'NODE'
const [json, expectedPath, expectedProjectPath] = process.argv.slice(2);
const runtimes = JSON.parse(json);
if (runtimes.runsc?.path !== expectedPath) {
  throw new Error(`Docker runsc path mismatch: expected ${expectedPath}, got ${runtimes.runsc?.path ?? 'missing'}.`);
}
if (runtimes['runsc-project']?.path !== expectedProjectPath) {
  throw new Error(`Docker runsc-project path mismatch: expected ${expectedProjectPath}, got ${runtimes['runsc-project']?.path ?? 'missing'}.`);
}
NODE

service_cgroup="$(systemctl --user show docker.service --property=ControlGroup --value)"
slice_cgroup="$(systemctl --user show "${SANDBOX_SLICE}" --property=ControlGroup --value)"
[[ -n "${service_cgroup}" && -n "${slice_cgroup}" && "${service_cgroup}" == "${slice_cgroup}/"* ]] \
  || fail 'The rootless Docker service is not inside the configured sandbox slice.'
service_cgroup_dir="/sys/fs/cgroup/${service_cgroup#/}"
slice_cgroup_dir="/sys/fs/cgroup/${slice_cgroup#/}"
[[ "$(<"${service_cgroup_dir}/cpu.max")" == '100000 100000' ]] || fail 'The rootless Docker CPU quota is not active.'
[[ "$(<"${service_cgroup_dir}/memory.max")" == '805306368' ]] || fail 'The rootless Docker memory limit is not active.'
[[ "$(<"${service_cgroup_dir}/memory.swap.max")" == '0' ]] || fail 'The rootless Docker swap limit is not active.'
[[ "$(<"${service_cgroup_dir}/pids.max")" == '256' ]] || fail 'The rootless Docker task limit is not active.'
[[ "$(<"${slice_cgroup_dir}/cpu.max")" == '100000 100000' ]] || fail 'The sandbox slice CPU quota is not active.'
[[ "$(<"${slice_cgroup_dir}/memory.max")" == '1610612736' ]] || fail 'The sandbox slice memory limit is not active.'
[[ "$(<"${slice_cgroup_dir}/memory.swap.max")" == '0' ]] || fail 'The sandbox slice swap limit is not active.'
[[ "$(<"${slice_cgroup_dir}/pids.max")" == '512' ]] || fail 'The sandbox slice task limit is not active.'

say 'Requirements are installed. Rootless Docker, the gVisor runtimes, and resource limits are ready.'
say 'The Docker CLI context has been restored; this setup did not modify the system-wide Docker daemon.'
say 'Next: npm ci, npm run sandbox:build, then npm start.'
