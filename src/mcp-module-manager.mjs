import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fromJSONSchema } from 'zod/v4';

const execFileAsync = promisify(execFile);
const moduleIdPattern = /^[a-z][a-z0-9-]{1,31}$/;
const capabilityIdPattern = /^[a-z][a-z0-9:._-]{1,63}$/;
const supportedPlatforms = new Set(['win32', 'linux', 'darwin', 'all']);
const blockedChildEnvironment = new Set([
  'MCP_AUTH_PASSWORD', 'MCP_PUBLIC_URL', 'MCP_MODULES_FILE', 'MCP_ADMIN_PASSWORD',
]);
const maxModules = 32;
const maxToolsPerModule = 256;
const maxSkillBytes = 64 * 1024;
const clientCloseTimeoutMs = 2_000;

async function closeClient(client, timeoutMs = clientCloseTimeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => client.close()).then(() => true, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new Error('Module registry must be a version 1 object.');
  }
  if (!Array.isArray(value.modules) || value.modules.length > maxModules) {
    throw new Error(`Module registry must contain no more than ${maxModules} modules.`);
  }
  if (!Array.isArray(value.skills) || value.skills.length > 100) {
    throw new Error('Module registry must contain no more than 100 skills.');
  }

  const moduleIds = new Set();
  const modules = value.modules.map((module) => {
    if (!module || typeof module !== 'object' || Array.isArray(module)) throw new Error('Each module must be an object.');
    const id = cleanText(module.id, 'Module id', 32).toLowerCase();
    if (!moduleIdPattern.test(id) || moduleIds.has(id)) throw new Error(`Invalid or duplicate module id: ${id}.`);
    moduleIds.add(id);
    const name = cleanText(module.name, `Module ${id} name`, 100);
    const command = cleanText(module.command, `Module ${id} command`, 260);
    if (!Array.isArray(module.args) || module.args.length > 64
      || module.args.some((arg) => typeof arg !== 'string' || arg.length > 2_000)) {
      throw new Error(`Module ${id} args must be an array of at most 64 strings, each at most 2,000 characters.`);
    }
    const platforms = Array.isArray(module.platforms) ? [...new Set(module.platforms)] : [];
    if (!platforms.length || platforms.some((item) => !supportedPlatforms.has(item))) {
      throw new Error(`Module ${id} must list one or more supported platforms.`);
    }
    if (!module.capabilities || typeof module.capabilities !== 'object' || Array.isArray(module.capabilities)) {
      throw new Error(`Module ${id} must define capability labels.`);
    }
    const capabilities = {};
    for (const [capability, definition] of Object.entries(module.capabilities)) {
      if (!capabilityIdPattern.test(capability) || !definition || typeof definition !== 'object') {
        throw new Error(`Module ${id} has an invalid capability definition.`);
      }
      capabilities[capability] = {
        label: cleanText(definition.label, `Capability ${capability} label`, 140),
        defaultSelected: definition.defaultSelected === true,
      };
    }
    const env = Object.create(null);
    if (module.env !== undefined && (!module.env || typeof module.env !== 'object' || Array.isArray(module.env))) {
      throw new Error(`Module ${id} env must be an object of string values.`);
    }
    for (const [key, rawValue] of Object.entries(module.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || blockedChildEnvironment.has(key.toUpperCase())) {
        throw new Error(`Module ${id} cannot set environment variable ${key}.`);
      }
      if (typeof rawValue !== 'string' || rawValue.length > 4_096) throw new Error(`Module ${id} env values must be strings of at most 4,096 characters.`);
      env[key] = rawValue;
    }
    const toolPolicies = Object.create(null);
    if (module.toolPolicies !== undefined && (!module.toolPolicies || typeof module.toolPolicies !== 'object' || Array.isArray(module.toolPolicies))) {
      throw new Error(`Module ${id} toolPolicies must be an object.`);
    }
    for (const [toolName, policy] of Object.entries(module.toolPolicies ?? {})) {
      if (!toolName || toolName.length > 128 || !policy || typeof policy !== 'object' || Array.isArray(policy)) {
        throw new Error(`Module ${id} has an invalid policy for tool ${toolName}.`);
      }
      const capability = String(policy.capability ?? '');
      if (policy.enabled === true && !Object.hasOwn(capabilities, capability)) {
        throw new Error(`Enabled tool ${id}.${toolName} must use one of the module's declared capabilities.`);
      }
      toolPolicies[toolName] = { enabled: policy.enabled === true, capability };
    }
    return {
      id,
      name,
      command,
      args: [...module.args],
      env,
      cwd: typeof module.cwd === 'string' && module.cwd.trim() ? module.cwd.trim() : undefined,
      platforms,
      enabled: module.enabled === true,
      capabilities,
      toolPolicies,
    };
  });

  const skillIds = new Set();
  const skills = value.skills.map((skill) => {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) throw new Error('Each skill must be an object.');
    const id = cleanText(skill.id, 'Skill id', 64).toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id) || skillIds.has(id)) throw new Error(`Invalid or duplicate skill id: ${id}.`);
    skillIds.add(id);
    const platforms = Array.isArray(skill.platforms) ? [...new Set(skill.platforms)] : [];
    if (!platforms.length || platforms.some((item) => !supportedPlatforms.has(item))) throw new Error(`Skill ${id} must list supported platforms.`);
    const content = typeof skill.content === 'string' ? skill.content : '';
    if (!content.trim() || Buffer.byteLength(content, 'utf8') > maxSkillBytes) throw new Error(`Skill ${id} content must be 1-${maxSkillBytes} UTF-8 bytes.`);
    return {
      id,
      name: cleanText(skill.name, `Skill ${id} name`, 100),
      description: typeof skill.description === 'string' ? skill.description.slice(0, 240) : '',
      platforms,
      enabled: skill.enabled === true,
      content,
    };
  });
  return { version: 1, modules, skills };
}

function defaultRegistry({ windowsServerPath, skillContent }) {
  return {
    version: 1,
    modules: [
      {
        id: 'browser',
        name: 'Existing browser tabs (Playwright Extension)',
        enabled: true,
        platforms: ['win32', 'linux', 'darwin'],
        command: 'npx',
        args: ['-y', '@playwright/mcp@0.0.85', '--extension', '--background'],
        capabilities: {
          'browser:observe': { label: 'Read existing browser tabs and page content' },
          'browser:navigate': { label: 'Navigate existing browser tabs' },
          'browser:interact': { label: 'Click, type, and interact with web pages' },
        },
        toolPolicies: {},
      },
      {
        id: 'windows-desktop',
        name: 'Windows desktop (UI Automation)',
        enabled: true,
        platforms: ['win32'],
        command: windowsServerPath || 'windows-mcp-server.exe',
        args: ['stdio', '--toolsets', 'screen,interaction,apps'],
        capabilities: {
          'desktop:observe': { label: 'Read Windows desktop and accessibility information' },
          'desktop:interact': { label: 'Click, type, and interact with Windows apps' },
          'desktop:apps': { label: 'Launch and manage Windows app windows' },
        },
        toolPolicies: {},
      },
    ],
    skills: skillContent ? [{
      id: 'gemini-local-tools',
      name: 'Gemini local tools',
      description: 'How Gemini should choose and use this stack’s local tools.',
      enabled: true,
      platforms: ['all'],
      content: skillContent,
    }] : [],
  };
}

function exposedToolName(moduleId, remoteName) {
  const normalized = String(remoteName).replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `mcp_${moduleId}_${normalized}`.slice(0, 64);
  return name;
}

function platformMatches(module, currentPlatform) {
  return module.platforms.includes('all') || module.platforms.includes(currentPlatform);
}

export class McpModuleManager {
  constructor({ configPath, windowsServerPath, skillContent = '', platform = process.platform, discoveryTimeoutMs = 15_000, toolCallTimeoutMs = 60_000 } = {}) {
    this.configPath = configPath ?? join(process.cwd(), '.gemini-mcp', 'modules.json');
    this.windowsServerPath = windowsServerPath;
    this.skillContent = skillContent;
    this.platform = platform;
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    if (!Number.isSafeInteger(toolCallTimeoutMs) || toolCallTimeoutMs < 1) throw new Error('toolCallTimeoutMs must be a positive safe integer.');
    this.toolCallTimeoutMs = toolCallTimeoutMs;
    this.operationQueue = Promise.resolve();
    this.config = null;
    this.activeModules = new Map();
    this.moduleStatuses = new Map();
    this.exposedTools = [];
  }

  async load() {
    try {
      this.config = validateConfig(JSON.parse(await readFile(this.configPath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not load MCP module registry ${this.configPath}: ${error.message}`);
      this.config = validateConfig(defaultRegistry({ windowsServerPath: this.windowsServerPath, skillContent: this.skillContent }));
      await this.persist(this.config);
    }
    await this.activate();
  }

  async persist(config) {
    const directory = dirname(this.configPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (process.platform === 'win32') {
        const identity = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
        const sid = /S-1-\d+(?:-\d+)+/.exec(identity.stdout)?.[0];
        if (!sid) throw new Error('Could not determine the current Windows account SID for module registry ACLs.');
        await execFileAsync('icacls.exe', [temporaryPath, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
      }
      await rename(temporaryPath, this.configPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  mergeBlankSecrets(input) {
    const previous = new Map((this.config?.modules ?? []).map((module) => [module.id, module.env ?? {}]));
    for (const module of input.modules ?? []) {
      const oldEnv = previous.get(module.id) ?? {};
      for (const [key, value] of Object.entries(module.env ?? {})) {
        if (value === '' && typeof oldEnv[key] === 'string') module.env[key] = oldEnv[key];
      }
    }
    return input;
  }

  async saveAndApply(rawConfig) {
    return this.enqueueOperation(async () => {
      const config = validateConfig(this.mergeBlankSecrets(clone(rawConfig)));
      await this.persist(config);
      this.config = config;
      await this.activateModules();
      return this.snapshot();
    });
  }

  async activate() {
    return this.enqueueOperation(() => this.activateModules());
  }

  enqueueOperation(operation) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async activateModules() {
    const previous = [...this.activeModules.values()];
    this.activeModules.clear();
    this.exposedTools = [];
    const closeResults = await Promise.all(previous.map(({ client }) => closeClient(client)));
    if (closeResults.some((closed) => !closed)) console.warn('An MCP child did not close within the 2-second cleanup limit.');
    this.moduleStatuses.clear();

    for (const module of this.config.modules) {
      const status = { id: module.id, state: 'disabled', error: '', tools: [] };
      this.moduleStatuses.set(module.id, status);
      if (!module.enabled) continue;
      if (!platformMatches(module, this.platform)) {
        status.state = 'inactive-platform';
        continue;
      }
      let client;
      let transport;
      let stderrTail = '';
      try {
        client = new Client({ name: `gemini-gateway-${module.id}`, version: '1.0.0' });
        transport = new StdioClientTransport({
          command: module.command,
          args: module.args,
          env: module.env,
          cwd: module.cwd,
          stderr: 'pipe',
        });
        transport.stderr?.on('data', (chunk) => {
          stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4_000);
        });
        let timeout;
        try {
          await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('MCP server handshake timed out after 20 seconds.')), 20_000); }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        let discoveryTimeout;
        let listed;
        try {
          listed = await Promise.race([
            client.listTools(),
            new Promise((_, reject) => {
              discoveryTimeout = setTimeout(() => reject(new Error(`MCP tool discovery timed out after ${this.discoveryTimeoutMs} ms.`)), this.discoveryTimeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(discoveryTimeout);
        }
        const tools = Array.isArray(listed.tools) ? listed.tools.slice(0, maxToolsPerModule) : [];
        const active = { module, client, tools };
        const moduleTools = [];
        const exposedNames = new Set(this.exposedTools.map(({ name }) => name));
        status.tools = tools.map((tool) => ({
          name: tool.name,
          title: tool.title ?? '',
          description: typeof tool.description === 'string' ? tool.description.slice(0, 2_000) : '',
          readOnly: tool.annotations?.readOnlyHint === true,
          enabled: module.toolPolicies[tool.name]?.enabled === true,
          capability: module.toolPolicies[tool.name]?.capability ?? '',
        }));
        for (const tool of tools) {
          const policy = module.toolPolicies[tool.name];
          if (!policy?.enabled || !Object.hasOwn(module.capabilities, policy.capability)) continue;
          let inputSchema;
          try {
            inputSchema = fromJSONSchema(tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false });
          } catch (error) {
            status.error = `Tool ${tool.name} has an unsupported input schema: ${error.message}`.slice(0, 1_000);
            continue;
          }
          const exposedName = exposedToolName(module.id, tool.name);
          if (exposedNames.has(exposedName)) {
            console.warn(`Skipping colliding MCP module tool name ${exposedName}.`);
            continue;
          }
          exposedNames.add(exposedName);
          moduleTools.push({
            moduleId: module.id,
            moduleName: module.name,
            remoteName: tool.name,
            name: exposedName,
            title: (tool.title ?? tool.name).slice(0, 100),
            description: typeof tool.description === 'string' ? tool.description.slice(0, 2_000) : `Proxy for ${module.name} tool ${tool.name}.`,
            inputSchema,
            annotations: tool.annotations,
            capability: policy.capability,
          });
        }
        this.exposedTools.push(...moduleTools);
        this.activeModules.set(module.id, active);
        status.state = 'connected';
      } catch (error) {
        status.tools = [];
        if (client) await closeClient(client);
        status.state = 'error';
        status.error = `${error instanceof Error ? error.message : 'MCP server could not start.'}${stderrTail ? `\n${stderrTail}` : ''}`.slice(-4_500);
        console.error(`MCP module ${module.id} did not start. See the local admin dashboard for details.`);
      }
    }
  }

  async callTool(moduleId, remoteName, args) {
    const active = this.activeModules.get(moduleId);
    if (!active) throw new Error(`MCP module ${moduleId} is not connected.`);
    const tool = active.tools.find((item) => item.name === remoteName);
    const policy = active.module.toolPolicies[remoteName];
    if (!tool || !policy?.enabled || !Object.hasOwn(active.module.capabilities, policy.capability)) {
      throw new Error('This MCP tool is not currently enabled by the administrator.');
    }
    let timeout;
    try {
      return await Promise.race([
        active.client.callTool({ name: remoteName, arguments: args ?? {} }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error(`MCP tool ${moduleId}.${remoteName} timed out after ${this.toolCallTimeoutMs} ms; the module was disconnected from the gateway.`);
            error.code = 'MCP_TOOL_CALL_TIMEOUT';
            reject(error);
          }, this.toolCallTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (error?.code === 'MCP_TOOL_CALL_TIMEOUT') await this.invalidateTimedOutModule(moduleId, active, error.message);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async invalidateTimedOutModule(moduleId, active, message) {
    if (this.activeModules.get(moduleId) !== active) return;
    this.activeModules.delete(moduleId);
    this.exposedTools = this.exposedTools.filter((tool) => tool.moduleId !== moduleId);
    const status = this.moduleStatuses.get(moduleId);
    if (status) {
      status.state = 'error';
      status.error = message.slice(0, 1_000);
      status.tools = [];
    }
    const closed = await closeClient(active.client);
    if (!closed) console.warn(`MCP module ${moduleId} did not close within the 2-second cleanup limit after a tool timeout.`);
  }

  getCapabilityChoices() {
    const choices = new Map();
    for (const tool of this.exposedTools) {
      const active = this.activeModules.get(tool.moduleId);
      const definition = active?.module.capabilities[tool.capability];
      if (!definition || choices.has(tool.capability)) continue;
      choices.set(tool.capability, {
        id: tool.capability,
        label: definition.label,
        defaultSelected: definition.defaultSelected,
      });
    }
    return [...choices.values()];
  }

  getToolCapabilities() {
    return new Map(this.exposedTools.map((tool) => [tool.name, tool.capability]));
  }

  getExposedTools() {
    return this.exposedTools;
  }

  getActiveSkills() {
    const result = [];
    let bytes = 0;
    for (const skill of this.config.skills) {
      if (!skill.enabled || !(skill.platforms.includes('all') || skill.platforms.includes(this.platform))) continue;
      const skillBytes = Buffer.byteLength(skill.content, 'utf8');
      if (bytes + skillBytes > 64 * 1024) break;
      result.push(skill);
      bytes += skillBytes;
    }
    return result;
  }

  snapshot() {
    const config = clone(this.config);
    for (const module of config.modules) {
      for (const [key] of Object.entries(module.env ?? {})) module.env[key] = '';
    }
    return {
      platform: this.platform,
      config,
      modules: this.config.modules.map((module) => ({
        id: module.id,
        name: module.name,
        enabled: module.enabled,
        platforms: module.platforms,
        state: this.moduleStatuses.get(module.id)?.state ?? 'inactive',
        error: this.moduleStatuses.get(module.id)?.error ?? '',
        tools: this.moduleStatuses.get(module.id)?.tools ?? [],
      })),
      capabilities: this.getCapabilityChoices(),
      exposedTools: this.exposedTools.map(({ name, title, moduleId, remoteName, capability }) => ({
        name, title, moduleId, remoteName, capability,
      })),
    };
  }

  async close() {
    return this.enqueueOperation(async () => {
      const active = [...this.activeModules.values()];
      this.activeModules.clear();
      this.exposedTools = [];
      const closeResults = await Promise.all(active.map(({ client }) => closeClient(client)));
      if (closeResults.some((closed) => !closed)) console.warn('An MCP child did not close within the 2-second cleanup limit.');
    });
  }
}

export function registerModuleTools(server, manager) {
  for (const tool of manager.getExposedTools()) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }, async (args) => manager.callTool(tool.moduleId, tool.remoteName, args));
  }
}

export function registerSkillResources(server, skills) {
  for (const skill of skills) {
    const uri = `gemini-mcp://skills/${encodeURIComponent(skill.id)}`;
    server.registerResource(skill.id, uri, {
      title: skill.name,
      description: skill.description || `Skill for ${skill.name}`,
      mimeType: 'text/markdown',
    }, async (requestedUri) => ({
      contents: [{ uri: requestedUri.href, mimeType: 'text/markdown', text: skill.content }],
    }));
    server.registerPrompt(`skill_${skill.id.replace(/-/g, '_')}`, {
      title: skill.name,
      description: skill.description || `Use the ${skill.name} skill.`,
    }, async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: skill.content } }],
    }));
  }
}

export function defaultCapabilityForTool(module, tool) {
  const toolName = tool.name.toLowerCase();
  if (module.id === 'browser') {
    if (tool.annotations?.readOnlyHint) return 'browser:observe';
    if (/(navigate|goto|reload|back|forward|wait)/.test(toolName)) return 'browser:navigate';
    return 'browser:interact';
  }
  if (module.id === 'windows-desktop') {
    if (tool.annotations?.readOnlyHint || /(snapshot|screenshot|gettext|wait|guardrailstatus|displayinventory)/i.test(tool.name)) return 'desktop:observe';
    if (/^app$/i.test(tool.name)) return 'desktop:apps';
    return 'desktop:interact';
  }
  return Object.keys(module.capabilities)[0] ?? '';
}

export function blankPolicy(module, tool) {
  const capability = defaultCapabilityForTool(module, tool);
  return { enabled: false, capability };
}
