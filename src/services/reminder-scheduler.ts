import { getPendingReminders, markDelivered } from '../commands/reminder.js';
import { getBotApp } from '../llm/agents/config.js';
import { FeishuAPI } from '../feishu/api.js';
import { log } from '../utils/logger.js';

let timer: ReturnType<typeof setInterval> | null = null;

async function deliverFeishu(appId: string, targetId: string, message: string): Promise<void> {
  const appRow = getBotApp(appId);
  if (!appRow) {
    log.error(`[reminder] 未找到飞书 app: ${appId}`);
    return;
  }
  const api = new FeishuAPI({ appId: appRow.id, appSecret: appRow.secret, verificationToken: '', encryptKey: '' });
  const idType = targetId.startsWith('oc_') ? 'chat_id' : 'open_id';
  await api.sendMessageTo(targetId, idType, 'text', { text: `⏰ 提醒：${message}` });
}

async function deliverTelegram(targetId: string, message: string): Promise<void> {
  try {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'config/monitor.json'), 'utf-8'));
    const token = config.telegram?.botToken;
    if (!token) {
      log.error('[reminder] 未配置 telegram botToken，无法发送提醒');
      return;
    }
    const { TelegramAPI } = await import('../telegram/api.js');
    const api = new TelegramAPI(token, config.telegram?.proxy);
    await api.sendMessage(Number(targetId), `⏰ 提醒：${message}`);
  } catch (err: any) {
    log.error(`[reminder] Telegram 发送失败: ${err.message}`);
  }
}

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
      if (r.channel === 'feishu' && r.app_id) {
        await deliverFeishu(r.app_id, r.target_id, r.message);
      } else if (r.channel === 'telegram') {
        await deliverTelegram(r.target_id, r.message);
      } else {
        // cli or unknown — just log
        log.print(`⏰ [提醒] ${r.message}`);
      }
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
