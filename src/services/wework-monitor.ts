import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProxyAgent } from 'undici';
import { queryInfluxRaw } from '../db/influxdb.js';
import { log } from '../utils/logger.js';

interface MonitorConfig {
  telegram: { botToken: string; chatId: string; proxy?: string };
  influx: { database: string; measurement: string };
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

async function poll(): Promise<void> {
  const cfg = loadConfig();
  const { database, measurement } = cfg.influx;

  const senderFilter = cfg.senders
    .map(s => `"sender" = '${s.replace(/'/g, "\\'")}'`)
    .join(' OR ');

  const timeFilter = lastSeenTime
    ? ` AND time > '${lastSeenTime}'`
    : ` AND time > now() - 5m`;
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

      const msg = `<b>[企微监控]</b>\n<b>群聊:</b> ${escapeHtml(session)}\n<b>发送人:</b> ${escapeHtml(sender)}\n<b>时间:</b> ${escapeHtml(time)}\n<b>内容:</b>\n${escapeHtml(content)}`;
      await sendTelegram(msg);
      log.dim(`[monitor] 推送消息: ${sender} @ ${time}`);
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

export function startMonitor(): void {
  if (timer) {
    log.warn('[monitor] 已在运行中');
    return;
  }

  const cfg = loadConfig();

  if (!cfg.telegram.botToken || !cfg.telegram.chatId) {
    log.error('[monitor] 请先在 config/monitor.json 中配置 telegram.botToken 和 chatId');
    return;
  }
  if (cfg.senders.length === 0) {
    log.error('[monitor] 请先在 config/monitor.json 中配置 senders 列表');
    return;
  }

  const intervalMs = (cfg.pollingIntervalSec || 10) * 1000;
  log.success(`[monitor] 开始监控，轮询间隔 ${cfg.pollingIntervalSec}s，监控发送人: ${cfg.senders.join(', ')}`);

  // Run immediately, then on interval
  poll();
  timer = setInterval(poll, intervalMs);
}

export function stopMonitor(): void {
  if (!timer) {
    log.warn('[monitor] 未在运行');
    return;
  }
  clearInterval(timer);
  timer = null;
  lastSeenTime = null;
  log.success('[monitor] 已停止监控');
}

export function isMonitorRunning(): boolean {
  return timer !== null;
}
