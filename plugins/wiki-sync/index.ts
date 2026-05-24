import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';
import type { PluginModule, PluginContext } from '@samata/plugin-sdk';
import { runSync, type SyncConfig } from './src/sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, 'config', 'config.yaml');

let cronTimer: ReturnType<typeof setInterval> | null = null;
let dataDir = '';

function loadConfig(): SyncConfig | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as SyncConfig;
  } catch {
    return null;
  }
}

const plugin: PluginModule = {
  name: 'wiki-sync',
  description: 'Confluence wiki 同步守护进程',
  scope: 'universal',
  toolDefinitions: [],

  async handleTool() { return null; },

  async init(ctx: PluginContext) {
    dataDir = ctx.getDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
  },

  async start() {
    const config = loadConfig();
    if (!config?.cron?.schedule) return;

    const schedule = config.cron.schedule;
    const lastRunFile = path.join(dataDir, '.last_cron_run');

    console.log(`[wiki-sync] cron 已启动 (schedule: ${schedule})`);

    const checkAndRun = async () => {
      const now = new Date();
      const [cronMin, cronHour] = schedule.split(' ');
      if (String(now.getHours()) !== cronHour || String(now.getMinutes()) !== cronMin) return;

      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      let lastRun = '';
      try { lastRun = fs.readFileSync(lastRunFile, 'utf-8').trim(); } catch {}
      if (lastRun === today) return;

      fs.writeFileSync(lastRunFile, today, 'utf-8');
      console.log(`[wiki-sync] 定时同步触发 ${new Date().toISOString()}`);
      try {
        await runSync(config, false);
      } catch (e: any) {
        console.error(`[wiki-sync] 定时同步失败: ${e.message}`);
      }
    };

    cronTimer = setInterval(checkAndRun, 60_000);
    checkAndRun();
  },

  async stop() {
    if (cronTimer) {
      clearInterval(cronTimer);
      cronTimer = null;
      console.log('[wiki-sync] cron 已停止');
    }
  },
};

export default plugin;
