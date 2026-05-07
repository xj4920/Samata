/**
 * dream-scheduler.ts
 * Daily scheduler that triggers dream analysis at 2:00 AM (UTC+8).
 * Uses setInterval polling + date marker to ensure once-per-day execution.
 */
import { log } from '../utils/logger.js';
import { runDreamForAll } from './dream-analyze.js';

let timer: ReturnType<typeof setInterval> | null = null;
let lastRunDate: string | null = null;

const DREAM_HOUR = 2; // 凌晨 2 点 (UTC+8)
const POLL_INTERVAL_MS = 60_000; // 每分钟检查一次

function getBeijingDate(): { dateStr: string; hour: number } {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600_000);
  return {
    dateStr: utc8.toISOString().slice(0, 10),
    hour: utc8.getUTCHours(),
  };
}

function getYesterday(): string {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600_000 - 86400_000);
  return utc8.toISOString().slice(0, 10);
}

async function checkAndRun(): Promise<void> {
  const { dateStr, hour } = getBeijingDate();

  if (hour !== DREAM_HOUR) return;
  if (lastRunDate === dateStr) return;

  lastRunDate = dateStr;
  const yesterday = getYesterday();
  log.file(`[dream] 定时触发: 分析 ${yesterday} 的数据`);

  try {
    await runDreamForAll(yesterday);
  } catch (err: any) {
    log.error(`[dream] 执行失败: ${err.message}`);
  }
}

export function startDreamScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    checkAndRun().catch(err => log.error(`[dream] scheduler 异常: ${err.message}`));
  }, POLL_INTERVAL_MS);
  log.file(`[dream] 调度器已启动（每日 ${DREAM_HOUR}:00 UTC+8 执行）`);
}

export function stopDreamScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
