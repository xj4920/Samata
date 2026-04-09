import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryInfluxRaw, writeInfluxLineProtocol } from '../db/influxdb.js';
import { getFirstConnectedWsClient } from '../wework/bot.js';
import { log } from '../utils/logger.js';

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
  // hedge_ratio 保留三位小数
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

  // InfluxDB 2.x: same tags + same nanosecond timestamp → overwrite fields
  const tsNano = new Date(row.time).getTime() * 1_000_000;
  return `${MEASUREMENT},product_id=${productId},valuation_date=${valuationDate} ${fields} ${tsNano}`;
}

async function poll(): Promise<void> {
  const cfg = loadConfig();
  const chatId = cfg.weworkChatId;
  if (!chatId) return;

  const ws = getFirstConnectedWsClient();
  if (!ws) {
    log.dim(`${TAG} 无可用企微连接，跳过`);
    return;
  }

  const q = `SELECT * FROM "${MEASUREMENT}" WHERE "processed" = 0 ORDER BY time DESC LIMIT 50`;

  try {
    const rows = await queryInfluxRaw(DB, q);
    if (rows.length === 0) return;

    log.file(`${TAG} 发现 ${rows.length} 条未处理记录`);

    for (const row of rows) {
      const content = buildMessage(row);
      try {
        await ws.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } });
        log.file(`${TAG} 推送成功: ${row.product_name} @ ${row.valuation_date}`);

        const line = buildWriteBackLine(row);
        await writeInfluxLineProtocol(DB, line);
        log.dim(`${TAG} 标记已处理: ${row.product_id} @ ${row.valuation_date}`);
      } catch (err: any) {
        log.error(`${TAG} 推送/写回失败: ${err.message}`);
      }
    }
  } catch (err: any) {
    log.error(`${TAG} 轮询失败: ${err.message}`);
  }
}

export function startHedgeRatioMonitor(options?: { auto?: boolean }): void {
  if (timer) {
    log.print(`${TAG} 已在运行中`);
    return;
  }

  const cfg = loadConfig();

  if (options?.auto && cfg.enabled === false) {
    log.file(`${TAG} enabled=false，跳过自动启动`);
    return;
  }

  if (!cfg.weworkChatId) {
    log.file(`${TAG} 未配置 weworkChatId，跳过`);
    return;
  }

  const intervalMs = (cfg.pollingIntervalSec || 60) * 1000;

  log.print(`${TAG} 开始监控，轮询间隔 ${cfg.pollingIntervalSec || 60}s，推送群聊 ${cfg.weworkChatId}`);

  poll();
  timer = setInterval(poll, intervalMs);
}

export function stopHedgeRatioMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  config = null;
  log.print(`${TAG} 已停止`);
}

export function isHedgeRatioMonitorRunning(): boolean {
  return timer !== null;
}
