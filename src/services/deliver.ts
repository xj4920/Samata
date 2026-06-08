import { getBotApp } from '../llm/agents/config.js';
import { FeishuAPI } from '../feishu/api.js';
import { buildFeishuMarkdownCard } from '../feishu/markdown-card.js';
import { log } from '../utils/logger.js';

export async function deliverFeishu(appId: string, targetId: string, message: string): Promise<void> {
  const appRow = getBotApp(appId);
  if (!appRow) {
    log.error(`[deliver] 未找到飞书 app: ${appId}`);
    return;
  }
  const api = new FeishuAPI({ appId: appRow.id, appSecret: appRow.secret, verificationToken: '', encryptKey: '' });
  const idType = targetId.startsWith('oc_') ? 'chat_id' : 'open_id';
  try {
    await api.sendMessageTo(targetId, idType, 'interactive', buildFeishuMarkdownCard(message));
  } catch (err: any) {
    log.warn(`[deliver] 飞书 markdown card 发送失败，降级 text: ${err.message}`);
    await api.sendMessageTo(targetId, idType, 'text', { text: message });
  }
}

export async function deliverTelegram(targetId: string, message: string): Promise<void> {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const config = JSON.parse(readFileSync(resolve(process.cwd(), 'config/monitor.json'), 'utf-8'));
  const token = config.telegram?.botToken;
  if (!token) {
    log.error('[deliver] 未配置 telegram botToken，无法发送');
    return;
  }
  const { TelegramAPI } = await import('../telegram/api.js');
  const api = new TelegramAPI(token, config.telegram?.proxy);
  await api.sendMessage(Number(targetId), message);
}

export async function deliverWework(targetId: string, message: string): Promise<void> {
  const { getFirstConnectedWsClient } = await import('../wework/bot.js');
  const ws = getFirstConnectedWsClient();
  if (!ws) {
    log.error('[deliver] 无可用企微连接，无法发送');
    return;
  }
  await ws.sendMessage(targetId, { msgtype: 'markdown', markdown: { content: message } });
}

/**
 * Deliver a text message to the specified channel.
 * Returns true on success, false on failure (logged internally).
 */
export async function deliverMessage(
  channel: string,
  targetId: string | null,
  appId: string | null,
  message: string,
  tag = '[deliver]',
): Promise<boolean> {
  try {
    if (channel === 'feishu' && appId && targetId) {
      await deliverFeishu(appId, targetId, message);
    } else if (channel === 'telegram' && targetId) {
      await deliverTelegram(targetId, message);
    } else if (channel === 'wework' && targetId) {
      await deliverWework(targetId, message);
    } else {
      log.print(`⏰ ${tag} ${message}`);
    }
    return true;
  } catch (err: any) {
    log.error(`${tag} 投递失败 (${channel}/${targetId}): ${err.message}`);
    return false;
  }
}
