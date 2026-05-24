import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryInfluxRaw } from './influxdb.js';

type NotificationChannel = 'telegram' | 'feishu';

interface MonitorConfig {
  enabled?: boolean;
  telegram?: { botToken: string; chatId: string; proxy?: string };
  influx?: { database: string; measurement: string };
  notification?: {
    channels: NotificationChannel[];
    feishuChatId?: string;
    feishuUserId?: string;
  };
  senders?: string[];
  contentKeywords?: string[];
  pollingIntervalSec?: number;
}

let config: MonitorConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastSeenTime: string | null = null;

type SendTelegramFn = (text: string) => Promise<void>;
type SendFeishuFn = (text: string, receiveId: string, receiveIdType: 'chat_id' | 'user_id' | 'open_id') => Promise<void>;

let _sendTelegram: SendTelegramFn | null = null;
let _sendFeishu: SendFeishuFn | null = null;

export function setSendTelegram(fn: SendTelegramFn): void { _sendTelegram = fn; }
export function setSendFeishu(fn: SendFeishuFn): void { _sendFeishu = fn; }

function loadConfig(): MonitorConfig {
  if (config) return config;
  try {
    const file = resolve(process.cwd(), 'config/monitor.json');
    config = JSON.parse(readFileSync(file, 'utf-8')) as MonitorConfig;
  } catch {
    config = {};
  }
  return config;
}

async function sendNotification(text: string): Promise<void> {
  const cfg = loadConfig();
  const channels = cfg.notification?.channels || ['telegram'];
  const { feishuChatId, feishuUserId } = cfg.notification || {};

  const promises: Promise<void>[] = [];
  if (channels.includes('telegram') && _sendTelegram) {
    promises.push(_sendTelegram(text));
  }
  if (channels.includes('feishu') && _sendFeishu) {
    const id = feishuUserId || feishuChatId;
    if (id) {
      const idType = id.startsWith('oc_') ? 'chat_id' : id.startsWith('ou_') ? 'open_id' : 'user_id';
      promises.push(_sendFeishu(text, id, idType));
    }
  }

  await Promise.all(promises);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function poll(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.influx) return;
  if (!cfg.senders?.length && !cfg.contentKeywords?.length) return;
  const { database, measurement } = cfg.influx;

  const CST_OFFSET_MS = 8 * 3600_000;
  const ceiling = new Date(Date.now() + CST_OFFSET_MS - 60_000).toISOString();
  const startTime = !lastSeenTime || lastSeenTime < ceiling ? ceiling : lastSeenTime;

  const q = `SELECT * FROM "${measurement}" WHERE time > '${startTime}' ORDER BY time ASC LIMIT 100`;

  try {
    const rows = await queryInfluxRaw(database, q);
    if (rows.length === 0) return;

    const senderSet = new Set(cfg.senders ?? []);
    const keywords = cfg.contentKeywords ?? [];

    for (const row of rows) {
      const sender = row.sender ?? 'unknown';
      const session = row.session ?? '';
      const content = row.content ?? row.message ?? '';
      const time = row.time ?? '';

      const matchesSender = senderSet.has(sender);
      const matchesKeyword = keywords.some(kw => content.includes(kw));
      if (!matchesSender && !matchesKeyword) continue;

      const msg = `<b>[企微监测]</b>\n<b>群聊:</b> ${escapeHtml(session)}\n<b>发送人:</b> ${escapeHtml(sender)}\n<b>时间:</b> ${escapeHtml(time)}\n<b>内容:</b>\n${escapeHtml(content)}`;
      await sendNotification(msg);
      const displayTime = time ? time.replace('T', ' ').replace('Z', '') : time;
      console.log(`[wework-monitor] 推送消息: ${sender} @ ${displayTime}`);
    }

    lastSeenTime = rows[rows.length - 1].time ?? lastSeenTime;
  } catch (err: any) {
    const detail = err.cause ? ` (${err.cause.message ?? err.cause})` : '';
    console.error(`[wework-monitor] 轮询失败: ${err.message}${detail}`);
  }
}

export function startWeworkMonitor(): void {
  if (timer) return;

  const cfg = loadConfig();
  const hasFilters = !!(cfg.senders?.length || cfg.contentKeywords?.length);

  if (cfg.enabled === false || !hasFilters || !cfg.influx) {
    console.log('[wework-monitor] 未配置或 enabled=false，跳过');
    return;
  }

  const channels = cfg.notification?.channels || ['telegram'];
  if (channels.includes('telegram') && (!cfg.telegram?.botToken || !cfg.telegram?.chatId)) {
    console.log('[wework-monitor] telegram 未配置 botToken/chatId，跳过');
    return;
  }
  if (channels.includes('feishu') && !cfg.notification?.feishuChatId && !cfg.notification?.feishuUserId) {
    console.log('[wework-monitor] feishu 未配置接收者，跳过');
    return;
  }

  const intervalMs = (cfg.pollingIntervalSec || 10) * 1000;
  const parts: string[] = [];
  if (cfg.senders?.length) parts.push(`发送人: ${cfg.senders.join(', ')}`);
  if (cfg.contentKeywords?.length) parts.push(`关键词: ${cfg.contentKeywords.join(', ')}`);
  console.log(`[wework-monitor] 开始监控，轮询间隔 ${cfg.pollingIntervalSec || 10}s，${parts.join('，')}`);

  poll();
  timer = setInterval(poll, intervalMs);
}

export function stopWeworkMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  lastSeenTime = null;
  config = null;
  console.log('[wework-monitor] 已停止');
}
