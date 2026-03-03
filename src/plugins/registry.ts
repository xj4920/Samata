import Database from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { log } from '../utils/logger.js';

export interface Plugin {
  name: string;
  description: string;
  execute: (db: Database.Database, args: string) => Promise<void> | void;
}

const plugins = new Map<string, Plugin>();

export function registerPlugin(plugin: Plugin): void {
  plugins.set(plugin.name, plugin);
}

export async function runPlugin(name: string, args: string): Promise<void> {
  const plugin = plugins.get(name);
  if (!plugin) {
    log.print(`未找到插件: ${name}`);
    listPlugins();
    return;
  }
  await plugin.execute(getDb(), args);
}

export function listPlugins(): void {
  if (plugins.size === 0) {
    log.print('暂无已注册插件');
    return;
  }
  log.print('已注册插件：');
  for (const [name, p] of plugins) {
    log.print(`  ${name.padEnd(16)} ${p.description}`);
  }
}

// Load built-in plugins
import { exportCsvPlugin } from './builtin/export-csv.js';
registerPlugin(exportCsvPlugin);
