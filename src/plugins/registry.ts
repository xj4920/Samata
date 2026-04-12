import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';
import type { PluginModule, PluginSkill, LoadedPlugin } from './types.js';
import type { ToolContext } from '../llm/agents/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'plugins');

const loadedPlugins = new Map<string, LoadedPlugin>();
let watcher: fs.FSWatcher | null = null;

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

    let skill: PluginSkill | undefined;
    const skillPath = path.join(pluginDir, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const raw = fs.readFileSync(skillPath, 'utf-8');
      skill = parseSkillMd(raw) ?? undefined;
    }

    loadedPlugins.set(plugin.name, { module: plugin, skill, dir: pluginDir, loadedAt: new Date() });
    log.info(`✅ Plugin [${plugin.name}]: ${plugin.toolDefinitions.length} tools loaded`);
  } catch (err: any) {
    log.warn(`⚠️  Plugin [${dirName}]: load failed — ${err.message}`);
  }
}

async function unloadPlugin(name: string): Promise<void> {
  loadedPlugins.delete(name);
  log.info(`Plugin [${name}]: unloaded`);
}

export async function initPlugins(): Promise<void> {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    log.dim('Created plugins/ directory');
  }

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await loadPlugin(path.join(PLUGINS_DIR, entry.name));
  }

  if (loadedPlugins.size > 0) {
    log.info(`Plugins initialized: ${loadedPlugins.size} loaded`);
  }

  startWatcher();
}

function startWatcher(): void {
  if (watcher) return;

  try {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    watcher = fs.watch(PLUGINS_DIR, { recursive: false }, (_eventType, filename) => {
      if (!filename) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const pluginDir = path.join(PLUGINS_DIR, filename);
        if (fs.existsSync(pluginDir) && fs.statSync(pluginDir).isDirectory()) {
          log.info(`Plugin change detected: ${filename}, reloading...`);
          await loadPlugin(pluginDir);
        } else {
          // Directory removed — unload if it was loaded
          for (const [name, loaded] of loadedPlugins) {
            if (path.basename(loaded.dir) === filename) {
              await unloadPlugin(name);
              break;
            }
          }
        }
      }, 500);
    });
  } catch {
    // fs.watch may not be available on all platforms
  }
}

export function stopPluginWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

export function getPluginTools(): Anthropic.Tool[] {
  return [...loadedPlugins.values()].flatMap(p => p.module.toolDefinitions);
}

export async function executePluginTool(name: string, input: any, ctx?: ToolContext): Promise<string | null> {
  for (const loaded of loadedPlugins.values()) {
    const result = await loaded.module.handleTool(name, input, ctx);
    if (result !== null) return result;
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
