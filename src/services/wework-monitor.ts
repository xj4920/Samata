import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProxyAgent } from 'undici';
import { queryInfluxRaw } from '../db/influxdb.js';
import { log } from '../utils/logger.js';
import { FeishuAPI } from '../feishu/api.js';

type NotificationChannel = 'telegram' | 'feishu';

interface MonitorConfig {
  enabled?: boolean;
  telegram: { botToken: string; chatId: string; proxy?: string };
  feishu: { appId: string; appSecret: string; proxy?: string };
  influx: { database: string; measurement: string };
  notification: {
    channels: NotificationChannel[];
    feishuChatId?: string;
    feishuUserId?: string;
  };
  senders: string[];
  pollingIntervalSec: number;
}

let config: MonitorConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastSeenTime: string | null = null;

function loadConfig(): MonitorConfig {
  if (config) return config;
  const file = resolve(process.cwd(), 'config/monitor.json');
  config = JSON.parse(readFileSync(file, 'utf-8')) as MonitorConfig;
  return config;
}

async function sendTelegram(text: string): Promise<void> {
  const { botToken, chatId, proxy } = loadConfig().telegram;
  if (!botToken || !chatId) return;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const opts: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  };
  if (proxy) {
    (opts as any).dispatcher = new ProxyAgent(proxy);
  }

  const resp = await fetch(url, opts);

  if (!resp.ok) {
    const body = await resp.text();
    log.error(`Telegram send failed (${resp.status}): ${body}`);
  }
}

let feishuApi: FeishuAPI | null = null;

/**
 * 发送飞书消息（支持群聊或个人用户）
 * @param text 消息内容
 * @param receiveId 接收者ID（群聊用chat_id，个人用户用user_id或open_id）
 * @param receiveIdType 接收者ID类型: chat_id | user_id | open_id
 */
async function sendFeishu(text: string, receiveId: string, receiveIdType: 'chat_id' | 'user_id' | 'open_id'): Promise<void> {
  const cfg = loadConfig();
  const { appId, appSecret, proxy } = cfg.feishu;

  if (!appId || !appSecret || !receiveId) return;

  if (!feishuApi) {
    // FeishuAPI 需要 verificationToken 和 encryptKey，但发送消息不需要
    feishuApi = new FeishuAPI({ appId, appSecret, verificationToken: '', encryptKey: '', proxy });
  }

  try {
    // 使用自定义的发送方法，支持指定 receive_id_type
    await feishuApi.sendMessageTo(receiveId, receiveIdType, 'text', { text });
  } catch (err: any) {
    log.error(`[monitor] 飞书发送失败: ${err.message}`);
  }
}

/**
 * 发送飞书通知（根据配置发送到群聊或个人用户）
 */
async function sendNotification(text: string): Promise<void> {
  const cfg = loadConfig();
  const channels = cfg.notification?.channels || ['telegram'];
  const { feishuChatId, feishuUserId } = cfg.notification || {};

  const promises: Promise<void>[] = [];
  if (channels.includes('telegram')) {
    promises.push(sendTelegram(text));
  }
  if (channels.includes('feishu')) {
    const id = feishuUserId || feishuChatId;
    if (id) {
      const idType = id.startsWith('oc_') ? 'chat_id' : id.startsWith('ou_') ? 'open_id' : 'user_id';
      promises.push(sendFeishu(text, id, idType));
    }
  }

  await Promise.all(promises);
}

async function poll(): Promise<void> {
  const cfg = loadConfig();
  const { database, measurement } = cfg.influx;

  const senderFilter = cfg.senders
    .map(s => `"sender" = '${s.replace(/'/g, "\\'")}'`)
    .join(' OR ');

  const CST_OFFSET_MS = 8 * 3600_000;
  const ceiling = new Date(Date.now() + CST_OFFSET_MS - 60_000).toISOString();
  const startTime = !lastSeenTime || lastSeenTime < ceiling ? ceiling : lastSeenTime;
  const timeFilter = ` AND time > '${startTime}'`;
  const where = senderFilter ? ` WHERE (${senderFilter})${timeFilter}` : '';

  const q = `SELECT * FROM "${measurement}"${where} ORDER BY time ASC LIMIT 100`;

  try {
    const rows = await queryInfluxRaw(database, q);
    if (rows.length === 0) return;

    for (const row of rows) {
      const sender = row.sender ?? 'unknown';
      const session = row.session ?? '';
      const content = row.content ?? row.message ?? '';
      const time = row.time ?? '';

      const msg = `<b>[企微监测]</b>\n<b>群聊:</b> ${escapeHtml(session)}\n<b>发送人:</b> ${escapeHtml(sender)}\n<b>时间:</b> ${escapeHtml(time)}\n<b>内容:</b>\n${escapeHtml(content)}`;
      await sendNotification(msg);
      const displayTime = time ? time.replace('T', ' ').replace('Z', '') : time;
      log.file(`[monitor] 推送消息: ${sender} @ ${displayTime}`);
    }

    lastSeenTime = rows[rows.length - 1].time ?? lastSeenTime;
  } catch (err: any) {
    const detail = err.cause ? ` (${err.cause.message ?? err.cause})` : '';
    log.error(`[monitor] 轮询失败: ${err.message}${detail}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function startMonitor(options?: { auto?: boolean }): void {
  if (timer) {
    log.print('[monitor] 已在运行中');
    return;
  }

  const cfg = loadConfig();

  // 自动启动时检查 enabled 配置
  if (options?.auto && cfg.enabled === false) {
    log.file('[monitor] 配置 enabled=false，跳过自动启动');
    return;
  }

  // 验证通知渠道配置
  const channels = cfg.notification?.channels || ['telegram'];
  const hasTelegram = channels.includes('telegram');
  const hasFeishu = channels.includes('feishu');
  const { feishuChatId, feishuUserId } = cfg.notification || {};

  if (hasTelegram && (!cfg.telegram?.botToken || !cfg.telegram?.chatId)) {
    log.print('[monitor] 通知渠道包含 telegram，但未配置 telegram.botToken 或 chatId');
    return;
  }
  if (hasFeishu && !cfg.feishu.appId || !cfg.feishu.appSecret) {
    log.print('[monitor] 通知渠道包含 feishu，但未配置 feishu.appId 或 appSecret');
    return;
  }
  if (hasFeishu && !feishuChatId && !feishuUserId) {
    log.print('[monitor] 通知渠道包含 feishu，但未配置 feishuChatId 或 feishuUserId');
    return;
  }
  if (channels.length === 0) {
    log.print('[monitor] 请在 config/monitor.json 的 notification.channels 中配置至少一个通知渠道');
    return;
  }
  if (cfg.senders.length === 0) {
    log.print('[monitor] 请先在 config/monitor.json 中配置 senders 列表');
    return;
  }

  const intervalMs = (cfg.pollingIntervalSec || 10) * 1000;
  
  // 显示通知目标
  let notifyTarget = '';
  if (channels.includes('feishu')) {
    if (feishuUserId) {
      notifyTarget = `飞书个人用户(${feishuUserId})`;
    } else if (feishuChatId) {
      notifyTarget = `飞书群聊(${feishuChatId})`;
    }
  }
  
  log.file(`[monitor] 开始监控，轮询间隔 ${cfg.pollingIntervalSec}s，监控发送人: ${cfg.senders.join(', ')}`);
  if (notifyTarget) {
    log.print(`[monitor] 通知目标: ${notifyTarget}`);
  }

  // Run immediately, then on interval
  poll();
  timer = setInterval(poll, intervalMs);
}

export function stopMonitor(): void {
  if (!timer) {
    log.print('[monitor] 未在运行');
    return;
  }
  clearInterval(timer);
  timer = null;
  lastSeenTime = null;
  log.print('[monitor] 已停止监控');
}

export function isMonitorRunning(): boolean {
  return timer !== null;
}
