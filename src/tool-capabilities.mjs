/**
 * Server-side capability enforcement for MCP tools.
 * OAuth login grants capabilities; model instructions and MCP annotations never grant them.
 */
export const toolCapabilities = Object.freeze({
  run_sandbox_bash: 'sandbox:execute',
  run_sandbox_session: 'sandbox:execute',
  run_host_commands: 'host:execute',
  mcp_status: 'gateway:status',
  desktop_act_and_observe: 'desktop:interact',
  desktop_run_steps: 'desktop:interact',
  run_wsl_command: 'wsl:execute',
  run_wsl_container: 'wsl:docker',
  list_files: 'filesystem:read',
  read_file: 'filesystem:read',
  search_files: 'filesystem:read',
  write_file: 'filesystem:write',
  edit_file: 'filesystem:write',
  list_projects: 'project:execute',
  get_project_diff: 'project:execute',
  start_project_session: 'project:execute',
  run_project_checks: 'project:execute',
  start_project_preview: 'project:execute',
  list_project_sessions: 'project:execute',
  stop_project_preview: 'project:execute',
  stop_project_session: 'project:execute',
  create_review_run: 'project:execute',
  update_review_checklist: 'project:execute',
  save_review_artifact: 'project:execute',
  save_review_screenshot: 'project:execute',
  list_review_runs: 'project:execute',
  read_review_artifact: 'project:execute',
  finalize_review_run: 'project:execute',
});

/** Return the first denied call, or null if all tool calls are permitted. */
export function deniedToolCall(body, authorizedCapabilities, activeToolCapabilities = toolCapabilities, {
  getSandboxSessionNetworkAccess = () => false,
  getProjectSessionNetworkAccess = () => false,
} = {}) {
  const granted = new Set(authorizedCapabilities);
  for (const request of Array.isArray(body) ? body : [body]) {
    if (!request || request.method !== 'tools/call') continue;
    const tool = request.params?.name;
    // Let the MCP protocol handler return method/tool validation errors.
    if (typeof tool !== 'string') continue;
    const required = activeToolCapabilities instanceof Map
      ? activeToolCapabilities.get(tool)
      : Object.hasOwn(activeToolCapabilities, tool) ? activeToolCapabilities[tool] : undefined;
    if (!required || !granted.has(required)) {
      return { tool, capability: required ?? 'unknown-tool' };
    }
    const args = request.params?.arguments ?? {};
    if (tool === 'run_sandbox_bash' && args?.internet_access === true
      && !granted.has('sandbox:network')) {
      return { tool, capability: 'sandbox:network' };
    }
    if (tool === 'run_sandbox_session') {
      const newSessionRequestsNetwork = args?.internet_access === true;
      const reusedSessionHasNetwork = typeof args?.session_id === 'string'
        && getSandboxSessionNetworkAccess(args.session_id) === true;
      if ((newSessionRequestsNetwork || reusedSessionHasNetwork) && !granted.has('sandbox:network')) {
        return { tool, capability: 'sandbox:network' };
      }
    }
    const startsNetworkProject = tool === 'start_project_session' && args.internet_access === true;
    const reusesNetworkProject = (tool === 'run_project_checks' || tool === 'start_project_preview')
      && typeof args.session_id === 'string' && getProjectSessionNetworkAccess(args.session_id) === true;
    if ((startsNetworkProject || reusesNetworkProject) && !granted.has('project:network')) {
      return { tool, capability: 'project:network' };
    }
  }
  return null;
}
