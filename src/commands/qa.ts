/**
 * /qa — QA 提取管线 CLI 入口
 * 通过 child_process.spawn 调用 scripts/ 下的独立脚本
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

interface Subcommand {
  script: string;
  requiresTopic: boolean;
  description: string;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  clean:    { script: 'scripts/clean-topic.ts',                  requiresTopic: true,  description: '清理指定主题的提取数据' },
  extract:  { script: 'scripts/incremental-extract.ts',          requiresTopic: false, description: '增量提取 Q&A' },
  merge:    { script: 'scripts/merge-qa.ts',                     requiresTopic: false, description: '合并相似 Q&A（交互式）' },
  review:   { script: 'scripts/review-qa.ts',                    requiresTopic: false, description: '审核 Q&A（交互式）' },
  validate: { script: 'scripts/validate-extraction-coverage.ts', requiresTopic: false, description: '验证提取完整性' },
  score:    { script: 'scripts/score-topic.ts',                  requiresTopic: true,  description: '评估 Q&A 质量' },
};

function runScript(scriptPath: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', scriptPath, ...args], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function handleQA(args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[0]?.toLowerCase();

  if (!subcommand || subcommand === 'help') {
    showHelp();
    return;
  }

  const subcmd = SUBCOMMANDS[subcommand];
  if (!subcmd) {
    log.print(`未知子命令: ${subcommand}`);
    showHelp();
    return;
  }

  const topic = parts[1];
  if (subcmd.requiresTopic && !topic) {
    log.print(`用法: /qa ${subcommand} <topic-name>`);
    return;
  }

  const scriptArgs = parts.slice(1); // topic + 额外参数（如 limit）

  // --- 释放 stdin 给子进程 ---
  const wasRaw = process.stdin.isTTY && (process.stdin as any).isRaw;
  if (wasRaw) process.stdin.setRawMode(false);
  process.stdin.pause();
  const savedListeners = process.stdin.listeners('data').slice();
  process.stdin.removeAllListeners('data');

  try {
    const code = await runScript(
      path.join(PROJECT_ROOT, subcmd.script),
      scriptArgs,
    );
    if (code !== 0) {
      log.print(`\n脚本退出码: ${code}`);
    }
  } catch (err: any) {
    log.print(`执行失败: ${err.message}`);
  } finally {
    // 恢复 stdin 状态
    for (const fn of savedListeners) {
      process.stdin.on('data', fn as (...a: any[]) => void);
    }
    process.stdin.resume();
    if (wasRaw && process.stdin.isTTY) process.stdin.setRawMode(true);
  }
}

function showHelp(): void {
  log.print('Q&A 提取管线:');
  log.print('  用法: /qa <子命令> [topic] [options]\n');
  log.print('子命令:');
  for (const [name, info] of Object.entries(SUBCOMMANDS)) {
    const hint = info.requiresTopic ? ' <topic>' : ' [topic]';
    log.print(`  ${name.padEnd(10)} ${info.description}${hint}`);
  }
  log.print('\n示例:');
  log.print('  /qa extract FIX协议对接');
  log.print('  /qa merge FIX协议对接');
  log.print('  /qa review FIX协议对接');
  log.print('  /qa validate FIX协议对接');
  log.print('  /qa clean FIX协议对接');
}
