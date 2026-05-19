import { getPendingReminders, markDelivered } from '../commands/reminder.js';
import { deliverMessage } from './deliver.js';
import { log } from '../utils/logger.js';

let timer: ReturnType<typeof setInterval> | null = null;

async function checkAndDeliver(): Promise<void> {
  let reminders: Awaited<ReturnType<typeof getPendingReminders>>;
  try {
    reminders = getPendingReminders();
  } catch (err: any) {
    log.error(`[reminder] 查询失败: ${err.message}`);
    return;
  }

  for (const r of reminders) {
    try {
      await deliverMessage(r.channel, r.target_id, r.app_id, `⏰ 提醒：${r.message}`, '[reminder]');
      markDelivered(r.id);
      log.file(`[reminder] 已投递: ${r.id.slice(0, 8)} → ${r.channel}/${r.target_id}`);
    } catch (err: any) {
      log.error(`[reminder] 投递失败 ${r.id.slice(0, 8)}: ${err.message}`);
    }
  }
}

export function startReminderScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    checkAndDeliver().catch(err => log.error(`[reminder] checkAndDeliver 异常: ${err.message}`));
  }, 30_000);
  log.file('[reminder] 提醒调度器已启动（轮询间隔 30s）');
}

export function stopReminderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
