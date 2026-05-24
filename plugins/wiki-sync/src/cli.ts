/**
 * cli.ts — wiki-sync 独立 CLI 入口
 *
 * 用法（从项目根目录执行）:
 *   npx tsx plugins/wiki-sync/src/cli.ts sync [--full] [--pages ids] [--pages-descendants]
 *   npx tsx plugins/wiki-sync/src/cli.ts export [--pages ...]
 *   npx tsx plugins/wiki-sync/src/cli.ts import
 *   npx tsx plugins/wiki-sync/src/cli.ts status
 *   npx tsx plugins/wiki-sync/src/cli.ts cron
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';
import { runSync, runExport, runImportOnly, showStatus, type SyncConfig } from './sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.WIKI_SYNC_CONFIG || path.resolve(__dirname, '..', 'config', 'config.yaml');

function loadConfig(): SyncConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`配置文件不存在: ${CONFIG_PATH}`);
    console.error('请复制 config.example.yaml → config.yaml 并填写连接信息');
    process.exit(1);
  }
  return yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as SyncConfig;
}

function validateConfig(config: SyncConfig, hasCliPages: boolean): void {
  const errors: string[] = [];

  if (!config.confluence?.url) errors.push('confluence.url 未配置');
  if (!config.confluence?.username) errors.push('confluence.username 未配置');
  if (!config.confluence?.api_token) errors.push('confluence.api_token 未配置');
  if (!config.samata?.base_url) errors.push('samata.base_url 未配置');
  if (!config.samata?.username) errors.push('samata.username 未配置');
  if (!config.samata?.agent_name) errors.push('samata.agent_name 未配置');

  if (!hasCliPages) {
    const hasPages = config.sync?.pages && config.sync.pages.length > 0;
    const hasSpaces = config.sync?.spaces && config.sync.spaces.length > 0;
    if (!hasPages && !hasSpaces) {
      errors.push('sync.spaces 或 sync.pages 至少配置一个，或通过 --pages <ids> 指定');
    }
  }

  if (errors.length > 0) {
    console.error('配置错误:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

function parseCliArgs(): { cmd: string; flags: Record<string, string> } {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[arg] = next;
          i++;
        } else {
          flags[arg] = 'true';
        }
      }
    }
  }

  return { cmd, flags };
}

function parsePagesFlag(flags: Record<string, string>): string[] | undefined {
  const val = flags['--pages'];
  if (!val) return undefined;
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function main(): void {
  const { cmd, flags } = parseCliArgs();

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`wiki-sync — Confluence Wiki → Samata 同步工具

用法:
  npx tsx plugins/wiki-sync/src/cli.ts sync [--full] [--pages <id1,id2,...>] [--pages-descendants]
  npx tsx plugins/wiki-sync/src/cli.ts export [--pages <id1,id2,...>] [--pages-descendants]
  npx tsx plugins/wiki-sync/src/cli.ts import
  npx tsx plugins/wiki-sync/src/cli.ts status
  npx tsx plugins/wiki-sync/src/cli.ts cron

配置文件: ${CONFIG_PATH}
环境变量 WIKI_SYNC_CONFIG 可覆盖配置文件路径
`);
    return;
  }

  const config = loadConfig();
  const cliPages = parsePagesFlag(flags);
  const cliDescendants = '--pages-descendants' in flags;
  validateConfig(config, !!cliPages);

  switch (cmd) {
    case 'sync': {
      const fullSync = flags['--full'] === 'true';
      runSync(config, fullSync, cliPages, cliDescendants);
      break;
    }
    case 'export': {
      runExport(config, cliPages, cliDescendants);
      break;
    }
    case 'import': {
      runImportOnly(config);
      break;
    }
    case 'status': {
      showStatus(config);
      break;
    }
    case 'cron': {
      const schedule = config.cron?.schedule || '0 2 * * *';
      console.log(`启动每日定时任务 (cron: ${schedule})`);
      console.log(`按 Ctrl+C 停止`);

      const checkAndRun = async () => {
        const now = new Date();
        const [cronMin, cronHour] = schedule.split(' ');
        if (String(now.getHours()) === cronHour && String(now.getMinutes()) === cronMin) {
          const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          const lastRunFile = path.join(path.dirname(CONFIG_PATH), '..', 'data', '.last_cron_run');
          let lastRun = '';
          try { lastRun = fs.readFileSync(lastRunFile, 'utf-8').trim(); } catch {}

          if (lastRun !== today) {
            fs.mkdirSync(path.dirname(lastRunFile), { recursive: true });
            fs.writeFileSync(lastRunFile, today, 'utf-8');
            console.log(`\n[${new Date().toISOString()}] 定时任务触发`);
            try {
              await runSync(config, false);
            } catch (e: any) {
              console.error(`定时任务失败: ${e.message}`);
            }
          }
        }
      };

      setInterval(checkAndRun, 60_000);
      checkAndRun();
      break;
    }
    default: {
      console.error(`未知命令: ${cmd}`);
      console.error('用法: npx tsx plugins/wiki-sync/src/cli.ts <sync|export|import|status|cron|help>');
      process.exit(1);
    }
  }
}

main();
