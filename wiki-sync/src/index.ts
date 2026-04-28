/**
 * index.ts — wiki-sync CLI 入口
 *
 * 命令:
 *   node src/index.ts sync [--full]   增量/全量同步 (cf-export + import)
 *   node src/index.ts export          仅 cf-export
 *   node src/index.ts import          仅导入 (从已有 archive)
 *   node src/index.ts status          查看状态
 *   node src/index.ts cron            启动每日定时任务
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { runSync, runExport, runImportOnly, showStatus, type SyncConfig } from './cron.js';

const CONFIG_PATH = path.resolve('config.yaml');

function loadConfig(): SyncConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`配置文件不存在: ${CONFIG_PATH}`);
    console.error('请复制 config.yaml 并填写 Confluence 和 Samata 的连接信息');
    process.exit(1);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return yaml.parse(raw) as SyncConfig;
}

function validateConfig(config: SyncConfig, hasCliPages: boolean): void {
  const errors: string[] = [];

  if (!config.confluence?.url) errors.push('confluence.url 未配置');
  if (!config.confluence?.username) errors.push('confluence.username 未配置');
  if (!config.confluence?.api_token) errors.push('confluence.api_token 未配置');
  if (!config.samata?.base_url) errors.push('samata.base_url 未配置');
  if (!config.samata?.username) errors.push('samata.username 未配置');
  if (!config.samata?.agent_name) errors.push('samata.agent_name 未配置');

  // sync source: CLI --pages > config pages > config spaces
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
        // next arg is the value (if it doesn't start with --)
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[arg] = next;
          i++;
        } else {
          flags[arg] = 'true'; // boolean flag
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
  npm start -- sync [--full] [--pages <id1,id2,...>] [--pages-descendants]
      增量/全量同步 (cf-export + import)
      --pages <ids>    只同步指定页面 ID（逗号分隔）
      --pages-descendants  页面 ID 含全部子页

  npm start -- export [--pages <id1,id2,...>] [--pages-descendants]
      仅执行 cf-export

  npm start -- import
      仅导入 (从已有 archive 目录)

  npm start -- status
      查看同步状态

  npm start -- cron
      启动每日定时任务

配置文件: ${CONFIG_PATH}
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
      // 每日定时任务
      const schedule = config.cron?.schedule || '0 2 * * *';
      console.log(`启动每日定时任务 (cron: ${schedule})`);
      console.log(`按 Ctrl+C 停止`);

      // 简单的间隔检查（每分钟检查一次是否到预定时间）
      // 生产环境建议使用 node-cron 或系统 crontab
      const checkAndRun = async () => {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();
        const dayOfMonth = now.getDate();

        const [cronMin, cronHour] = schedule.split(' ');
        if (String(hour) === cronHour && String(minute) === cronMin) {
          // 避免同一天重复执行（在 0-59 分钟窗口内只执行一次）
          const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
          const lastRunFile = path.join(path.dirname(CONFIG_PATH), 'data', '.last_cron_run');
          let lastRun = '';
          try { lastRun = fs.readFileSync(lastRunFile, 'utf-8').trim(); } catch {}

          if (lastRun !== today) {
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

      // 每分钟检查一次
      setInterval(checkAndRun, 60_000);
      checkAndRun(); // 启动时也检查一次
      break;
    }
    default: {
      console.error(`未知命令: ${cmd}`);
      console.error('用法: node src/index.ts <sync|export|import|status|cron|help>');
      process.exit(1);
    }
  }
}

main();
