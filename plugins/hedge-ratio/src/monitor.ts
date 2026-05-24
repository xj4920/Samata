import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryInfluxRaw, writeInfluxLineProtocol } from './influxdb.js';

const DB = 'otchk';
const MEASUREMENT = 'hedge_ratio';
const TAG = '[hedge-ratio]';

interface HedgeRatioConfig {
  enabled?: boolean;
  pollingIntervalSec?: number;
  weworkChatId?: string;
}

let config: HedgeRatioConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let sendMessageFn: ((chatId: string, msg: { msgtype: string; markdown: { content: string } }) => Promise<void>) | null = null;

function loadConfig(): HedgeRatioConfig {
  if (config) return config;
  try {
    const file = resolve(process.cwd(), 'config/monitor.json');
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    config = (raw.hedgeRatio ?? {}) as HedgeRatioConfig;
  } catch {
    config = {};
  }
  return config;
}

function formatNumber(val: any): string {
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val ?? '');
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildMessage(row: Record<string, any>): string {
  const hedgeRatio = Number(row.hedge_ratio).toFixed(3);
  return [
    '**套保比例提醒**',
    `1. **估值日期**：${row.valuation_date ?? ''}`,
    `2. **产品名称**：${row.product_name ?? ''}`,
    `3. **套保比例**：${hedgeRatio}`,
    `4. **股指期货多头市值**：${formatNumber(row.future_long_market_value)}`,
    `5. **股指期货空头市值**：${formatNumber(row.future_short_market_value)}`,
    `6. **中证1800成分股市值**：${formatNumber(row.component_stocks_market_value)}`,
    `7. **估值表**：${row.valuation_file ?? ''}`,
  ].join('\n');
}

function escapeLineProtocolTag(s: string): string {
  return s.replace(/[, =]/g, c => '\\' + c);
}

function escapeLineProtocolField(s: string): string {
  return s.replace(/["\\]/g, c => '\\' + c);
}

function buildWriteBackLine(row: Record<string, any>): string {
  const productId = escapeLineProtocolTag(String(row.product_id ?? ''));
  const valuationDate = escapeLineProtocolTag(String(row.valuation_date ?? ''));

  const fields = [
    `product_name="${escapeLineProtocolField(String(row.product_name ?? ''))}"`,
    `valuation_file="${escapeLineProtocolField(String(row.valuation_file ?? ''))}"`,
    `future_long_market_value=${Number(row.future_long_market_value) || 0}`,
    `future_short_market_value=${Number(row.future_short_market_value) || 0}`,
    `component_stocks_market_value=${Number(row.component_stocks_market_value) || 0}`,
    `hedge_ratio=${Number(row.hedge_ratio) || 0}`,
    `updatetime="${escapeLineProtocolField(String(row.updatetime ?? ''))}"`,
    `processed=1i`,
  ].join(',');

  const tsNano = new Date(row.time).getTime() * 1_000_000;
  return `${MEASUREMENT},product_id=${productId},valuation_date=${valuationDate} ${fields} ${tsNano}`;
}

async function poll(): Promise<void> {
  const cfg = loadConfig();
  const chatId = cfg.weworkChatId;
  if (!chatId || !sendMessageFn) return;

  const q = `SELECT * FROM "${MEASUREMENT}" WHERE "processed" = 0 ORDER BY time DESC LIMIT 50`;

  try {
    const rows = await queryInfluxRaw(DB, q);
    if (rows.length === 0) return;

    console.log(`${TAG} 发现 ${rows.length} 条未处理记录`);

    for (const row of rows) {
      const content = buildMessage(row);
      try {
        await sendMessageFn(chatId, { msgtype: 'markdown', markdown: { content } });
        console.log(`${TAG} 推送成功: ${row.product_name} @ ${row.valuation_date}`);

        const line = buildWriteBackLine(row);
        await writeInfluxLineProtocol(DB, line);
      } catch (err: any) {
        console.error(`${TAG} 推送/写回失败: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`${TAG} 轮询失败: ${err.message}`);
  }
}

export function setSendMessage(fn: (chatId: string, msg: { msgtype: string; markdown: { content: string } }) => Promise<void>): void {
  sendMessageFn = fn;
}

export function startHedgeRatioMonitor(): void {
  if (timer) return;

  const cfg = loadConfig();

  if (cfg.enabled === false) {
    console.log(`${TAG} enabled=false，跳过`);
    return;
  }

  if (!cfg.weworkChatId) {
    console.log(`${TAG} 未配置 weworkChatId，跳过`);
    return;
  }

  const intervalMs = (cfg.pollingIntervalSec || 60) * 1000;
  console.log(`${TAG} 开始监控，轮询间隔 ${cfg.pollingIntervalSec || 60}s，推送群聊 ${cfg.weworkChatId}`);

  poll();
  timer = setInterval(poll, intervalMs);
}

export function stopHedgeRatioMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  config = null;
  console.log(`${TAG} 已停止`);
}
