import type Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';
import { getCurrentUser, isAgentAdmin } from '../auth/rbac.js';
import { getContextAgent, isScheduledTaskAuthorized } from '../runtime/execution-context.js';
import { getSandboxRoot } from '../commands/sandbox.js';
import { createReminder } from '../commands/reminder.js';
import { sendWeworkNotification } from '../wework/notification-queue.js';
import type { PluginModule, PluginSkill, PluginContext, LoadedPlugin } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const PLUGINS_DIRS = (process.env.SAMATA_PLUGINS_DIR || '../samata-plugins')
  .split(',')
  .map(d => path.resolve(PROJECT_ROOT, d.trim()));
const NPM_PLUGIN_PREFIX = '@samata-platform/plugin-';

type PluginDeliveryContext = { channel: string; targetId?: string; appId?: string };

async function callLLMImpl(messages: Array<{role: string; content: string}>, options?: {system?: string; max_tokens?: number}): Promise<string> {
  const { getProvider, getModelName } = await import('../llm/provider.js');
  const provider = getProvider();
  const response = await provider.createMessage({
    model: getModelName(),
    max_tokens: options?.max_tokens || 4096,
    system: options?.system || '',
    tools: [],
    messages: messages as any,
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  return (textBlock as any)?.text || '';
}

async function sendNotificationImpl(channel: string, targetId: string, message: string, deliveryCtx?: PluginDeliveryContext): Promise<void> {
  if (channel === 'feishu') {
    const { FeishuAPI } = await import('../feishu/api.js');
    const { getDb } = await import('../db/connection.js');
    const db = getDb();
    const preferredAppId = deliveryCtx?.channel === 'feishu' ? deliveryCtx.appId : undefined;
    const row = preferredAppId
      ? db.prepare("SELECT * FROM bot_apps WHERE id = ? AND channel = 'feishu' LIMIT 1").get(preferredAppId) as any
      : undefined;
    const fallbackRow = row ?? db.prepare(
      "SELECT * FROM bot_apps WHERE name = 'monitor-bot' AND channel = 'feishu' LIMIT 1"
    ).get() as any;
    if (!fallbackRow) {
      throw new Error(preferredAppId ? `No feishu bot configured for app ${preferredAppId}` : 'No feishu monitor bot configured');
    }
    const cfg = JSON.parse(fallbackRow.config || '{}');
    const api = new FeishuAPI({
      appId: fallbackRow.id,
      appSecret: fallbackRow.secret,
      verificationToken: cfg.verification_token || '',
      encryptKey: cfg.encrypt_key || '',
    });
    const idType = targetId.startsWith('oc_') ? 'chat_id' : 'open_id';
    await api.sendMessageTo(targetId, idType, 'text', { text: message });
  } else if (channel === 'wework' || channel.startsWith('wework:')) {
    const [, botIdOrName] = channel.split(':', 2);
    await sendWeworkNotification(targetId, message, botIdOrName);
  } else {
    throw new Error(`Unsupported notification channel: ${channel}`);
  }
}

function buildPluginContext(pluginName: string): PluginContext {
  const dataDir = path.join(PROJECT_ROOT, 'data', 'plugins', pluginName);
  const configDir = path.join(PROJECT_ROOT, 'config');
  return {
    getCurrentUser: () => {
      const u = getCurrentUser();
      return { id: u.id, name: u.display_name || u.username, role: u.role };
    },
    getDataDir: () => dataDir,
    getAgentId: () => getContextAgent()?.id,
    getSandboxRoot: () => {
      const agent = getContextAgent();
      if (!agent) return undefined;
      try {
        return getSandboxRoot(agent.name, getCurrentUser().id);
      } catch {
        return undefined;
      }
    },
    getDeliveryContext: () => undefined,
    callLLM: callLLMImpl,
    sendNotification: sendNotificationImpl,
    getConfigDir: () => configDir,
  };
}

const loadedPlugins = new Map<string, LoadedPlugin>();
const watchers: fs.FSWatcher[] = [];

function parseSkillMd(content: string): PluginSkill | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  let name = '';
  let description = '';
  for (const line of frontmatter.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (!m) continue;
    if (m[1] === 'name') name = m[2].trim();
    if (m[1] === 'description') description = m[2].trim();
  }

  if (!name || !description) return null;
  return { name, description, content: body };
}

function validatePlugin(plugin: PluginModule, dirName: string): string | null {
  if (!plugin.name) return `Plugin [${dirName}]: missing name`;
  if (!Array.isArray(plugin.toolDefinitions)) return `Plugin [${dirName}]: toolDefinitions must be an array`;
  if (typeof plugin.handleTool !== 'function') return `Plugin [${dirName}]: handleTool must be a function`;
  return null;
}

function checkNameConflicts(plugin: PluginModule): string | null {
  for (const tool of plugin.toolDefinitions) {
    for (const [otherName, other] of loadedPlugins) {
      if (otherName === plugin.name) continue;
      if (other.module.toolDefinitions.some(t => t.name === tool.name)) {
        return `Tool name "${tool.name}" conflicts with plugin [${otherName}]`;
      }
    }
  }
  return null;
}

async function loadPlugin(pluginDir: string): Promise<void> {
  const dirName = path.basename(pluginDir);
  const entryPath = path.join(pluginDir, 'index.ts');

  if (!fs.existsSync(entryPath)) {
    log.warn(`Plugin [${dirName}]: no index.ts found, skipping`);
    return;
  }

  try {
    const mod = await import(`${entryPath}?t=${Date.now()}`);
    const plugin: PluginModule = mod.default;

    const validationError = validatePlugin(plugin, dirName);
    if (validationError) {
      log.warn(`⚠️  ${validationError}`);
      return;
    }

    const conflictError = checkNameConflicts(plugin);
    if (conflictError) {
      log.warn(`⚠️  Plugin [${dirName}]: ${conflictError}`);
      return;
    }

    const ctx = buildPluginContext(plugin.name);

    if (plugin.init) {
      await plugin.init(ctx);
    }

    let skill: PluginSkill | undefined;
    const skillPath = path.join(pluginDir, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const raw = fs.readFileSync(skillPath, 'utf-8');
      skill = parseSkillMd(raw) ?? undefined;
    }

    loadedPlugins.set(plugin.name, { module: plugin, context: ctx, skill, dir: pluginDir, loadedAt: new Date() });
    log.info(`✅ Plugin [${plugin.name}]: ${plugin.toolDefinitions.length} tools loaded`);
  } catch (err: any) {
    log.warn(`⚠️  Plugin [${dirName}]: load failed — ${err.message}`);
  }
}

async function unloadPlugin(name: string): Promise<void> {
  const loaded = loadedPlugins.get(name);
  if (loaded?.module.stop) {
    await loaded.module.stop();
  }
  loadedPlugins.delete(name);
  log.info(`Plugin [${name}]: unloaded`);
}

async function loadNpmPlugin(packageName: string): Promise<void> {
  try {
    const mod = await import(packageName);
    const plugin: PluginModule = mod.default;

    const shortName = packageName.startsWith(NPM_PLUGIN_PREFIX)
      ? packageName.slice(NPM_PLUGIN_PREFIX.length)
      : packageName;

    const validationError = validatePlugin(plugin, shortName);
    if (validationError) {
      log.warn(`⚠️  ${validationError}`);
      return;
    }

    if (loadedPlugins.has(plugin.name)) {
      log.dim(`Plugin [${plugin.name}]: already loaded from directory, skipping npm`);
      return;
    }

    const conflictError = checkNameConflicts(plugin);
    if (conflictError) {
      log.warn(`⚠️  Plugin [${shortName}]: ${conflictError}`);
      return;
    }

    const ctx = buildPluginContext(plugin.name);
    if (plugin.init) await plugin.init(ctx);

    loadedPlugins.set(plugin.name, { module: plugin, context: ctx, skill: undefined, dir: '', loadedAt: new Date() });
    log.info(`✅ Plugin [${plugin.name}] (npm: ${packageName}): ${plugin.toolDefinitions.length} tools loaded`);
  } catch (err: any) {
    log.warn(`⚠️  npm plugin [${packageName}]: load failed — ${err.message}`);
  }
}

function discoverNpmPlugins(): string[] {
  const pkgPath = path.join(PROJECT_ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.keys(deps).filter(name => name.startsWith(NPM_PLUGIN_PREFIX));
  } catch {
    return [];
  }
}

export async function initPlugins(): Promise<void> {
  // 1. Directory scan (source plugins / development)
  for (const dir of PLUGINS_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await loadPlugin(path.join(dir, entry.name));
    }
  }

  // 2. npm packages (production deployment)
  const npmPlugins = discoverNpmPlugins();
  for (const pkg of npmPlugins) {
    await loadNpmPlugin(pkg);
  }

  if (loadedPlugins.size > 0) {
    log.info(`Plugins initialized: ${loadedPlugins.size} loaded`);
  }

  startWatchers();
}

function startWatchers(): void {
  if (watchers.length > 0) return;

  for (const dir of PLUGINS_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const w = fs.watch(dir, { recursive: false }, (_eventType, filename) => {
        if (!filename) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const pluginDir = path.join(dir, filename);
          if (fs.existsSync(pluginDir) && fs.statSync(pluginDir).isDirectory()) {
            log.info(`Plugin change detected: ${filename}, reloading...`);
            await loadPlugin(pluginDir);
          } else {
            for (const [name, loaded] of loadedPlugins) {
              if (path.basename(loaded.dir) === filename) {
                await unloadPlugin(name);
                break;
              }
            }
          }
        }, 500);
      });
      watchers.push(w);
    } catch {
      // fs.watch may not be available on all platforms
    }
  }
}

export function stopPluginWatcher(): void {
  for (const w of watchers) w.close();
  watchers.length = 0;
}

export async function startAllPlugins(): Promise<void> {
  for (const loaded of loadedPlugins.values()) {
    if (loaded.module.start) {
      try {
        await loaded.module.start(loaded.context);
      } catch (err: any) {
        log.warn(`⚠️  Plugin [${loaded.module.name}]: start failed — ${err.message}`);
      }
    }
  }
}

export async function stopAllPlugins(): Promise<void> {
  for (const loaded of loadedPlugins.values()) {
    if (loaded.module.stop) {
      try {
        await loaded.module.stop();
      } catch { /* ignore */ }
    }
  }
}

/** All plugin tools (universal + agent-bound) */
export function getPluginTools(): Anthropic.Tool[] {
  return [...loadedPlugins.values()].flatMap(p => p.module.toolDefinitions) as Anthropic.Tool[];
}

/** Only universal plugin tools (auto-visible to all standard-mode agents) */
export function getUniversalPluginTools(): Anthropic.Tool[] {
  return [...loadedPlugins.values()]
    .filter(p => (p.module.scope ?? 'universal') === 'universal')
    .flatMap(p => p.module.toolDefinitions) as Anthropic.Tool[];
}

export async function executePluginTool(name: string, input: any, deliveryCtx?: PluginDeliveryContext): Promise<string | null> {
  for (const loaded of loadedPlugins.values()) {
    const agentId = getContextAgent()?.id;
    const ctx: PluginContext = {
      ...loaded.context,
      getDeliveryContext: () => deliveryCtx ? { channel: deliveryCtx.channel, targetId: deliveryCtx.targetId || '', appId: deliveryCtx.appId } : undefined,
      sendNotification: (channel, targetId, message) => sendNotificationImpl(channel, targetId, message, deliveryCtx),
      isAdmin: () => isScheduledTaskAuthorized() || (agentId ? isAgentAdmin(agentId) : false),
      createReminder: (params) => createReminder(params),
    };
    try {
      const result = await loaded.module.handleTool(name, input, ctx);
      if (result !== null) return result;
    } catch (err: any) {
      log.warn(`Plugin [${loaded.module.name}] handleTool error: ${err.message}`);
      return JSON.stringify({ error: `Plugin [${loaded.module.name}]: ${err.message}` });
    }
  }
  return null;
}

export function getPluginSkills(): PluginSkill[] {
  return [...loadedPlugins.values()]
    .filter(p => p.skill)
    .map(p => p.skill!);
}

export function getPluginSkillByName(name: string): PluginSkill | null {
  for (const loaded of loadedPlugins.values()) {
    if (loaded.skill && loaded.skill.name === name) return loaded.skill;
  }
  return null;
}

export function getLoadedPlugins(): Array<{ name: string; description: string; tools: string[]; hasSkill: boolean; loadedAt: Date }> {
  return [...loadedPlugins.values()].map(p => ({
    name: p.module.name,
    description: p.module.description,
    tools: p.module.toolDefinitions.map(t => t.name),
    hasSkill: !!p.skill,
    loadedAt: p.loadedAt,
  }));
}
