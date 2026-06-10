import fs from 'fs';
import { resolve } from 'path';
import { CronExpressionParser } from 'cron-parser';
import { runDreamForAll } from './dream-analyze.js';
import { log } from '../utils/logger.js';

const TAG = '[dream-scheduler]';
const DEFAULT_CRON = '0 3 * * *';
const DEFAULT_TZ = 'Asia/Chongqing';
const DEFAULT_LOCK_MS = 6 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function getYesterdayBeijing(): string {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600_000 - 86400_000);
  return utc8.toISOString().slice(0, 10);
}

function getLockPath(): string {
  const dir = resolve(process.cwd(), 'data/dreams');
  fs.mkdirSync(dir, { recursive: true });
  return resolve(dir, '.dream-scheduler.lock');
}

function readLock(lockPath: string): { expiresAt: number; pid?: number } | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

function acquireLock(lockMs = DEFAULT_LOCK_MS): boolean {
  const lockPath = getLockPath();
  const now = Date.now();
  const lockExists = fs.existsSync(lockPath);
  const existing = readLock(lockPath);
  if (existing && existing.expiresAt > now) return false;

  if (lockExists) {
    try { fs.unlinkSync(lockPath); } catch { return false; }
  }

  try {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: now, expiresAt: now + lockMs }),
      { encoding: 'utf-8', flag: 'wx' },
    );
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try { fs.unlinkSync(getLockPath()); } catch { /* ignore */ }
}

export async function runScheduledDream(dateStr = getYesterdayBeijing()): Promise<boolean> {
  if (running) {
    log.warn(`${TAG} 上一次执行仍在运行，跳过本轮`);
    return false;
  }
  if (!acquireLock()) {
    log.warn(`${TAG} 已有有效锁，跳过本轮`);
    return false;
  }

  running = true;
  try {
    log.file(`${TAG} 开始每日回顾: ${dateStr}`);
    await runDreamForAll(dateStr);
    log.file(`${TAG} 每日回顾完成: ${dateStr}`);
    return true;
  } catch (err: any) {
    log.error(`${TAG} 执行失败: ${err.message}`);
    return false;
  } finally {
    running = false;
    releaseLock();
  }
}

function computeNextDelay(cronExpr: string, tz: string, now = Date.now()): number {
  const expr = CronExpressionParser.parse(cronExpr, {
    tz,
    currentDate: new Date(now),
  });
  return Math.max(1, expr.next().getTime() - now);
}

function scheduleNext(): void {
  const cronExpr = process.env.DREAM_CRON_EXPR || DEFAULT_CRON;
  const tz = process.env.DREAM_TIMEZONE || DEFAULT_TZ;
  let delay: number;
  try {
    delay = computeNextDelay(cronExpr, tz);
  } catch (err: any) {
    log.error(`${TAG} 无效 cron 配置 ${cronExpr}: ${err.message}`);
    return;
  }

  const actualDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
  timer = setTimeout(async () => {
    timer = null;
    if (delay <= MAX_TIMER_DELAY_MS) {
      await runScheduledDream();
    }
    scheduleNext();
  }, actualDelay);

  log.file(`${TAG} 已调度下一次执行: ${new Date(Date.now() + delay).toISOString()} (${cronExpr}, ${tz})`);
}

export function startDreamScheduler(): void {
  if (timer || process.env.DREAM_SCHEDULER_DISABLED === '1') return;
  scheduleNext();
}

export function stopDreamScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export const __dreamSchedulerTest = {
  computeNextDelay,
};
