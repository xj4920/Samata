/**
 * Telegram 消息格式化工具
 * 将结构化数据转为 Telegram 友好的纯文本
 */
import { Client, STATE_LABELS } from '../models/client.js';
import type { AuditEvent } from '../models/event.js';
import type { TradeRow } from '../commands/trade.js';
import type { KnowledgeItem } from '../commands/knowledge.js';
import type { Skill } from '../commands/skill.js';

export function formatClientList(clients: Client[]): string {
  if (clients.length === 0) return '暂无客户数据';

  const lines = [`📋 客户列表 (共 ${clients.length} 条)`, ''];
  for (const c of clients) {
    const state = STATE_LABELS[c.state] || c.state;
    const sales = c.sales ? ` | ${c.sales}` : '';
    lines.push(`• ${c.name}  [${state}]${sales}`);
    if (c.tags) lines.push(`  标签: ${c.tags}`);
  }
  return lines.join('\n');
}

export function formatClientDetail(client: Client): string {
  const state = STATE_LABELS[client.state] || client.state;
  const lines = [
    `👤 ${client.name}`,
    '',
    `状态: ${state}`,
    `ID: ${client.id.slice(0, 8)}`,
  ];
  if (client.contact) lines.push(`联系方式: ${client.contact}`);
  if (client.wework_group) lines.push(`企微群: ${client.wework_group}`);
  if (client.requirements) lines.push(`需求: ${client.requirements}`);
  if (client.sales) lines.push(`销售: ${client.sales}`);
  if (client.tags) lines.push(`标签: ${client.tags}`);
  if (client.notes) lines.push(`备注: ${client.notes}`);
  lines.push(`创建: ${client.created_at}`);
  lines.push(`更新: ${client.updated_at}`);
  return lines.join('\n');
}

export function formatClientHistory(name: string, events: AuditEvent[]): string {
  if (events.length === 0) return `${name} 暂无操作记录`;

  const lines = [`📜 ${name} 的操作历史`, ''];
  for (const e of events) {
    const payload = e.payload ? ` ${e.payload}` : '';
    lines.push(`${e.created_at}  ${e.action}${payload}`);
  }
  return lines.join('\n');
}

function formatNum(val: number | null): string {
  if (val == null) return '-';
  return Number(val).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatTrades(trades: TradeRow[]): string {
  if (trades.length === 0) return '未查询到交易数据';

  const lines = [`📈 交易记录 (共 ${trades.length} 条)`, ''];
  for (const r of trades) {
    lines.push(`${r.date} | ${r.client} | ${r.counter_party}`);
    lines.push(`  名义本金: ${formatNum(r.notional_t)}  成交: ${formatNum(r.trade_amt_ft)}  净交易头寸: ${formatNum(r.ft_net)}`);
  }
  return lines.join('\n');
}

export function formatKnowledge(items: KnowledgeItem[]): string {
  if (items.length === 0) return '未找到相关FAQ';

  const lines = [`📚 知识库 (共 ${items.length} 条)`, ''];
  for (const item of items) {
    lines.push(`Q: ${item.question}`);
    lines.push(`A: ${item.answer}`);
    if (item.tags) lines.push(`标签: ${item.tags}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) return '暂无已保存的 skill';

  const lines = [`🧩 Skill 列表 (共 ${skills.length} 个)`, ''];
  for (const s of skills) {
    const params = [...new Set([...s.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]))];
    const paramStr = params.length > 0 ? `  参数: ${params.join(', ')}` : '';
    lines.push(`• ${s.name}${paramStr}`);
    lines.push(`  ${s.prompt.length > 60 ? s.prompt.slice(0, 60) + '...' : s.prompt}`);
  }
  return lines.join('\n');
}

export function formatSuccess(msg: string): string {
  return `✅ ${msg}`;
}

export function formatError(msg: string): string {
  return `❌ ${msg}`;
}
