/**
 * 飞书消息格式化工具
 * 大部分复用 Telegram 格式化逻辑，部分函数覆写为 markdown 表格以利用飞书卡片渲染
 */
import { Client, STATE_LABELS, STATE_PRIORITY } from '../models/client.js';
import { fetchLatestTradeData, formatNum } from '../commands/trade.js';

export {
  formatClientDetail,
  formatClientHistory,
  formatTrades,
  formatKnowledge,
  formatSkillList,
  formatSuccess,
  formatError,
} from '../telegram/formatter.js';

/**
 * 格式化客户列表为 markdown 表格（含 T 日交易数据），与 CLI 输出一致
 */
export async function formatClientList(clients: Client[]): Promise<string> {
  if (clients.length === 0) return '暂无客户数据';

  let tradeData = new Map<string, { notional_t: number; trade_amt_ft: number }>();
  let tradeDate = '';
  try {
    const result = await fetchLatestTradeData();
    tradeData = result.data;
    tradeDate = result.tradeDate;
  } catch {}

  // 按状态优先级 + T日存续名本排序（与 CLI 一致）
  const sorted = [...clients].sort((a, b) => {
    const stateDiff = (STATE_PRIORITY[b.state] ?? 0) - (STATE_PRIORITY[a.state] ?? 0);
    if (stateDiff !== 0) return stateDiff;
    return (tradeData.get(b.name.toLowerCase())?.notional_t ?? 0) - (tradeData.get(a.name.toLowerCase())?.notional_t ?? 0);
  });

  const lines: string[] = [];
  lines.push('| ID | 名称 | 状态 | T日存续名本 | T日成交金额 | 销售 | 标签 |');
  lines.push('|---|---|---|---|---|---|---|');

  for (const c of sorted) {
    const td = tradeData.get(c.name.toLowerCase());
    const row = [
      c.id.slice(0, 8),
      c.name,
      STATE_LABELS[c.state] || c.state,
      td ? formatNum(td.notional_t) : '-',
      td ? formatNum(td.trade_amt_ft) : '-',
      c.sales ?? '-',
      c.tags ?? '-',
    ];
    lines.push(`| ${row.join(' | ')} |`);
  }

  const dateSuffix = tradeDate && tradeDate !== '-' ? `，T日 = ${tradeDate}` : '';
  lines.push(`\n共 ${sorted.length} 条${dateSuffix}`);
  return lines.join('\n');
}
