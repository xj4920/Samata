import { getDb } from '../db/connection.js';
import { getCurrentUser, isSystemAdmin } from '../auth/rbac.js';
import { recordEvent, getEvents } from '../models/event.js';
import { Client, ClientState, STATE_LABELS, STATE_PRIORITY, STATES, nextState, prevState, classifyClient } from '../models/client.js';
import { log } from '../utils/logger.js';
import { renderTable } from '../utils/table.js';
import { v4 as uuid } from 'uuid';
import { fetchLatestTradeData, formatNum, ClientTradeData } from './trade.js';
import XLSX from 'xlsx';
import * as path from 'path';
import * as fs from 'fs';
import { loadCustomers, Customer } from '../config/customers.js';
import { getProviderForTask, getModelForTask } from '../llm/provider.js';

function parseKV(args: string): Record<string, string> {
  const result: Record<string, string> = {};
  const matches = args.matchAll(/(\w+)=(\S+)/g);
  for (const m of matches) {
    result[m[1]] = m[2];
  }
  return result;
}

export function add(args: string): void {
  const parts = args.match(/^(\S+)\s*(.*)/);
  if (!parts) {
    log.print('用法: add <名称> [contact=xx] [wework_group=xx] [sales=xx] [notes=xx]');
    return;
  }
  const name = parts[1];
  const kv = parseKV(parts[2] || '');
  const db = getDb();
  const user = getCurrentUser();
  const id = uuid();

  db.prepare(
    'INSERT INTO clients (id, name, contact, wework_group, requirements, sales, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, name, kv.contact ?? null, kv.wework_group ?? null, kv.requirements ?? null, kv.sales ?? null, kv.notes ?? null, user.id);

  recordEvent('client', id, 'create', { name, ...kv });
  log.print(`客户已添加: ${name} (${id.slice(0, 8)})`);
}

export function update(args: string): void {
  const parts = args.match(/^(\S+)\s+(.*)/);
  if (!parts) {
    log.print('用法: update <id> <field=value ...>');
    return;
  }
  const idPrefix = parts[1];
  const kv = parseKV(parts[2]);
  if (Object.keys(kv).length === 0) {
    log.print('请提供要更新的字段，如: name=xx wework_group=xx');
    return;
  }

  const db = getDb();
  const client = findByPrefix(idPrefix);
  if (!client) return;

  if ('state' in kv) {
    log.print('不允许通过 update 修改 state，请使用 advance 命令推进状态');
    return;
  }
  const allowed = ['name', 'contact', 'wework_group', 'requirements', 'sales', 'tags', 'notes',
    'long_financing_spread', 'short_financing', 'commission', 'commission_cost', 'net_comm', 'index_hedging', 'pricing_range', 'is_ft'];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(kv)) {
    if (!allowed.includes(k)) {
      log.print(`不支持更新字段: ${k}`);
      continue;
    }
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  vals.push(client.id);

  db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  recordEvent('client', client.id, 'update', kv);
  log.print(`客户已更新: ${client.name}`);
}

export function remove(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.print('用法: delete <id>');
    return;
  }
  const client = findByPrefix(idPrefix);
  if (!client) return;

  const db = getDb();
  db.prepare('DELETE FROM clients WHERE id = ?').run(client.id);
  recordEvent('client', client.id, 'delete', { name: client.name });
  log.print(`客户已删除: ${client.name}`);
}

export function advance(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.print('用法: advance <id>');
    return;
  }
  const client = findByPrefix(idPrefix);
  if (!client) return;

  const next = nextState(client.state);
  if (!next) {
    log.print(`客户 ${client.name} 已处于最终状态: ${STATE_LABELS[client.state]}`);
    return;
  }

  const db = getDb();
  db.prepare("UPDATE clients SET state = ?, updated_at = datetime('now') WHERE id = ?").run(next, client.id);
  recordEvent('client', client.id, 'advance', { from: client.state, to: next });
  log.print(`${client.name}: ${STATE_LABELS[client.state]} → ${STATE_LABELS[next]}`);
}

export function rollback(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.print('用法: rollback <id>');
    return;
  }
  const client = findByPrefix(idPrefix);
  if (!client) return;

  const prev = prevState(client.state);
  if (!prev) {
    log.print(`客户 ${client.name} 已处于初始状态: ${STATE_LABELS[client.state]}`);
    return;
  }

  const db = getDb();
  db.prepare("UPDATE clients SET state = ?, updated_at = datetime('now') WHERE id = ?").run(prev, client.id);
  recordEvent('client', client.id, 'rollback', { from: client.state, to: prev });
  log.print(`${client.name}: ${STATE_LABELS[client.state]} → ${STATE_LABELS[prev]}`);
}

export async function list(args: string): Promise<void> {
  const db = getDb();
  const kv = parseKV(args);
  let sql = 'SELECT * FROM clients';
  const params: any[] = [];

  if (kv.state && STATES.includes(kv.state as ClientState)) {
    sql += ' WHERE state = ?';
    params.push(kv.state);
  }
  const rows = db.prepare(sql).all(...params) as Client[];

  let tradeData = new Map<string, ClientTradeData>();
  let tradeDate = '';
  try {
    const result = await fetchLatestTradeData();
    tradeData = result.data;
    tradeDate = result.tradeDate;
  } catch {}

  rows.sort((a, b) => {
    const stateDiff = (STATE_PRIORITY[b.state] ?? 0) - (STATE_PRIORITY[a.state] ?? 0);
    if (stateDiff !== 0) return stateDiff;
    return (tradeData.get(b.name.toLowerCase())?.notional_t ?? 0) - (tradeData.get(a.name.toLowerCase())?.notional_t ?? 0);
  });

  if (rows.length === 0) {
    log.print('暂无客户数据');
    return;
  }

  const head = ['ID', '名称', '状态', 'T日存续名本', 'T日成交金额', '销售', '分类', '标签', '创建时间', '更新时间'];
  const tableRows = rows.map(c => {
    const td = tradeData.get(c.name.toLowerCase());
    const category = classifyClient(c.is_ft === 1, c.short_financing);
    return [
      c.id.slice(0, 8),
      c.name,
      STATE_LABELS[c.state] || c.state,
      td ? formatNum(td.notional_t) : '-',
      td ? formatNum(td.trade_amt_ft) : '-',
      c.sales ?? '-',
      category ?? '-',
      c.tags ?? '-',
      c.created_at,
      c.updated_at,
    ];
  });

  renderTable(head, tableRows);
  const dateSuffix = tradeDate && tradeDate !== '-' ? `，T日 = ${tradeDate}` : '';
  log.print(`共 ${rows.length} 条${dateSuffix}`);
}

export function view(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.print('用法: view <id>');
    return;
  }
  const client = findByPrefix(idPrefix);
  if (!client) return;

  const category = classifyClient(client.is_ft === 1, client.short_financing);

  log.print(`  ID:         ${client.id}`);
  log.print(`  名称:       ${client.name}`);
  log.print(`  WeWork Group: ${client.wework_group ?? '-'}`);
  log.print(`  需求:       ${client.requirements ?? '-'}`);
  log.print(`  销售:       ${client.sales ?? '-'}`);
  log.print(`  联系方式:   ${client.contact ?? '-'}`);
  log.print(`  状态:       ${STATE_LABELS[client.state]}`);
  log.print(`  标签:       ${client.tags ?? '-'}`);
  log.print(`  客户分类:   ${category ?? '-'}`);
  log.print(`  备注:       ${client.notes ?? '-'}`);
  log.print(`  --- 报价信息 ---`);
  const range = parsePricingRange(client.pricing_range);
  log.print(`  Long Financing Spread: ${formatFieldWithRange(client.long_financing_spread, range?.long_financing_spread)}`);
  log.print(`  Short Financing:       ${formatFieldWithRange(client.short_financing, range?.short_financing)}`);
  log.print(`  Commission:            ${formatFieldWithRange(client.commission, range?.commission)}`);
  log.print(`  Commission Cost:       ${formatFieldWithRange(client.commission_cost, range?.commission_cost)}`);
  log.print(`  Net Comm:              ${formatFieldWithRange(client.net_comm, range?.net_comm)}`);
  log.print(`  Index Hedging:         ${client.index_hedging === 1 ? '是' : client.index_hedging === 0 ? '否' : '-'}`);
  if (range?.products && range.products.length > 0) {
    log.print(`  报价来源产品:          ${range.products.join(', ')}`);
  }
  log.print(`  极速客户:              ${client.is_ft === 1 ? '是' : '否'}`);
  log.print(`  创建时间:   ${client.created_at}`);
  log.print(`  更新时间:   ${client.updated_at}`);
}

export function history(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.print('用法: history <id>');
    return;
  }
  const client = findByPrefix(idPrefix);
  if (!client) return;

  const events = getEvents(client.id);
  if (events.length === 0) {
    log.print('暂无操作记录');
    return;
  }

  log.print(`${client.name} 的操作历史：`);
  for (const e of events) {
    const payload = e.payload ? ` ${e.payload}` : '';
    log.print(`  ${e.created_at}  ${e.action.padEnd(10)}${payload}`);
  }
}

export function findByPrefix(prefix: string): Client | null {
  const db = getDb();
  // Try by name first (case-insensitive)
  let rows = db.prepare('SELECT * FROM clients WHERE name LIKE ? COLLATE NOCASE').all(`%${prefix}%`) as Client[];
  if (rows.length === 1) return rows[0];
  // Try by ID prefix
  if (rows.length === 0) {
    rows = db.prepare('SELECT * FROM clients WHERE id LIKE ?').all(`${prefix}%`) as Client[];
  }
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) {
    log.print(`匹配到多个客户，请提供更长的ID前缀：`);
    for (const c of rows) {
      log.print(`  ${c.id.slice(0, 8)}  ${c.name}`);
    }
    return null;
  }
  return null;
}

// --- Data functions for programmatic use (Telegram bot, agent, etc.) ---

export function fetchClients(filter?: { state?: string; keyword?: string }): Client[] {
  const db = getDb();
  let sql = 'SELECT * FROM clients';
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter?.state && STATES.includes(filter.state as ClientState)) {
    conditions.push('state = ?');
    params.push(filter.state);
  }
  if (filter?.keyword) {
    conditions.push('(name LIKE ? COLLATE NOCASE OR wework_group LIKE ? COLLATE NOCASE OR tags LIKE ? COLLATE NOCASE OR requirements LIKE ? COLLATE NOCASE OR notes LIKE ? COLLATE NOCASE)');
    const kw = `%${filter.keyword}%`;
    params.push(kw, kw, kw, kw, kw);
  }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');

  const rows = db.prepare(sql).all(...params) as Client[];
  rows.sort((a, b) => (STATE_PRIORITY[b.state] ?? 0) - (STATE_PRIORITY[a.state] ?? 0));
  return rows;
}

export function fetchClient(nameOrId: string): Client | null {
  return findByPrefix(nameOrId);
}

export function fetchHistory(nameOrId: string): { name: string; events: ReturnType<typeof getEvents> } | null {
  const client = findByPrefix(nameOrId);
  if (!client) return null;
  return { name: client.name, events: getEvents(client.id) };
}

export function createClient(input: { name: string; contact?: string; wework_group?: string; requirements?: string; sales?: string; notes?: string }): { success: true; id: string; name: string } | { success: false; error: string } {
  const db = getDb();
  const user = getCurrentUser();
  const id = uuid();

  db.prepare(
    'INSERT INTO clients (id, name, contact, wework_group, requirements, sales, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, input.name, input.contact ?? null, input.wework_group ?? null, input.requirements ?? null, input.sales ?? null, input.notes ?? null, user.id);

  recordEvent('client', id, 'create', input);
  return { success: true, id: id.slice(0, 8), name: input.name };
}

export function addClient(args: string): { success: true; id: string; name: string } | { success: false; error: string } {
  const parts = args.match(/^(\S+)\s*(.*)/);
  if (!parts) return { success: false, error: '用法: /add <名称> [contact=xx] [wework_group=xx] [sales=xx] [notes=xx]' };
  const kv = parseKV(parts[2] || '');
  return createClient({ name: parts[1], ...kv });
}

export function updateClient(nameOrId: string, fields: Record<string, string>): { success: true; name: string } | { success: false; error: string } {
  if ('state' in fields) return { success: false, error: '不允许通过 update 修改 state，请使用 advance 命令推进状态' };

  const client = findByPrefix(nameOrId);
  if (!client) return { success: false, error: `未找到客户: ${nameOrId}` };

  const db = getDb();
  const allowed = ['name', 'contact', 'wework_group', 'requirements', 'sales', 'tags', 'notes',
    'long_financing_spread', 'short_financing', 'commission', 'commission_cost', 'net_comm', 'index_hedging', 'pricing_range', 'is_ft'];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return { success: false, error: '没有可更新的字段' };

  sets.push("updated_at = datetime('now')");
  vals.push(client.id);
  db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  recordEvent('client', client.id, 'update', fields);
  return { success: true, name: client.name };
}

export function advanceClient(nameOrId: string): { success: true; name: string; from: string; to: string } | { success: false; error: string } {
  const client = findByPrefix(nameOrId);
  if (!client) return { success: false, error: `未找到客户: ${nameOrId}` };

  const next = nextState(client.state);
  if (!next) return { success: false, error: `客户 ${client.name} 已处于最终状态: ${STATE_LABELS[client.state]}` };

  const db = getDb();
  db.prepare("UPDATE clients SET state = ?, updated_at = datetime('now') WHERE id = ?").run(next, client.id);
  recordEvent('client', client.id, 'advance', { from: client.state, to: next });
  return { success: true, name: client.name, from: STATE_LABELS[client.state], to: STATE_LABELS[next] };
}

export function rollbackClient(nameOrId: string): { success: true; name: string; from: string; to: string } | { success: false; error: string } {
  const client = findByPrefix(nameOrId);
  if (!client) return { success: false, error: `未找到客户: ${nameOrId}` };

  const prev = prevState(client.state);
  if (!prev) return { success: false, error: `客户 ${client.name} 已处于初始状态: ${STATE_LABELS[client.state]}` };

  const db = getDb();
  db.prepare("UPDATE clients SET state = ?, updated_at = datetime('now') WHERE id = ?").run(prev, client.id);
  recordEvent('client', client.id, 'rollback', { from: client.state, to: prev });
  return { success: true, name: client.name, from: STATE_LABELS[client.state], to: STATE_LABELS[prev] };
}

export function deleteClient(
  nameOrId: string,
  dryRun: boolean = true,
):
  | { success: true; dry_run: boolean; id: string; name: string; state: string; tags: string | null; deleted?: boolean }
  | { success: false; error: string } {
  const client = findByPrefix(nameOrId);
  if (!client) return { success: false, error: `未找到客户: ${nameOrId}` };

  if (dryRun) {
    return {
      success: true,
      dry_run: true,
      id: client.id.slice(0, 8),
      name: client.name,
      state: STATE_LABELS[client.state] || client.state,
      tags: client.tags,
    };
  }

  const db = getDb();
  db.prepare('DELETE FROM clients WHERE id = ?').run(client.id);
  recordEvent('client', client.id, 'delete', { name: client.name });
  return {
    success: true,
    dry_run: false,
    deleted: true,
    id: client.id.slice(0, 8),
    name: client.name,
    state: STATE_LABELS[client.state] || client.state,
    tags: client.tags,
  };
}

// 报价 range JSON 的结构化类型
export interface PricingRangeField {
  min: number;
  max: number;
}

export interface PricingRange {
  long_financing_spread?: PricingRangeField | null;
  short_financing?: PricingRangeField | null;
  commission?: PricingRangeField | null;
  commission_cost?: PricingRangeField | null;
  net_comm?: PricingRangeField | null;
  products?: string[];
}

export function parsePricingRange(json: string | null | undefined): PricingRange | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as PricingRange;
  } catch {
    return null;
  }
}

const BP_FIELDS_DB = new Set(['commission', 'commission_cost', 'net_comm']);

export function formatFieldWithRange(value: number | null, range?: PricingRangeField | null): string {
  if (value === null || value === undefined) return '-';
  if (!range || range.min === range.max) return String(value);
  return `${value} (range: ${range.min} ~ ${range.max})`;
}

// 产品名精确（大小写不敏感）+ 模糊匹配到管理人
// 归一化 counter_party 名称：去空格/标点 + 剥离末尾法人后缀，便于跨数据源匹配
// 例：'JINDE CAPITAL' / 'JINDECAPITALLLC' 归一化后都是 'jindecapital'
function normalizeCounterpartyName(s: string): string {
  const compact = s.toLowerCase().replace(/[\s._\-]+/g, '');
  return compact.replace(/(llc|ltd|lp|fund|capital)$/i, '') || compact;
}

function productStringSimilarity(a: string, b: string): number {
  const s1 = normalizeCounterpartyName(a);
  const s2 = normalizeCounterpartyName(b);
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;
  const len = Math.max(s1.length, s2.length);
  if (len === 0) return 0;
  let matches = 0;
  for (let i = 0; i < Math.min(s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) matches++;
  }
  return matches / len;
}

export interface UnmatchedProductSuggestion {
  counter_party: string;
  manager: string;
  source?: 'heuristic' | 'llm';
}

// LLM 兜底：把启发式匹配失败的 counterparty 批量交给模型分类，返回 { counterparty: manager } 映射
// - 仅接受已存在于 customers.json 的 manager 作为结果，其他一律视为 unknown
// - 任何异常（provider 未初始化 / 网络 / JSON 解析失败）均降级为空 Map，绝不影响主流程
async function resolveUnmatchedByLLM(
  pending: string[],
  customers: Customer[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (pending.length === 0) return result;

  const validManagers = new Set(customers.map(c => c.name));
  const directory = customers.map(c => ({
    manager: c.name,
    products: c.products.map(p => p.counter_party),
  }));

  const prompt = `你是交易对手归属分类器。下面是已知"管理人 → 产品名列表"的目录，以及一批无法由字符串匹配识别的产品名。
请把每个产品名归属到目录里的某个 manager；如果缺少足够线索则返回 "unknown"。

目录 JSON：
${JSON.stringify(directory)}

待分类产品：
${JSON.stringify(pending)}

严格返回 JSON 对象，键为产品名（与输入一致），值为 manager 名或字符串 "unknown"。不要输出任何解释或额外文字。`;

  try {
    const provider = getProviderForTask('classification');
    const response = await provider.createMessage({
      model: getModelForTask('classification'),
      max_tokens: 1024,
      system: '你是严格的分类器，只输出 JSON，不输出任何解释。',
      tools: [],
      messages: [{ role: 'user', content: prompt }],
    });
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return result;
    const raw = textBlock.text.trim();
    // 兼容 ```json ... ``` 包裹
    const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(jsonText) as Record<string, string>;
    for (const cp of pending) {
      const manager = parsed[cp];
      if (typeof manager === 'string' && manager !== 'unknown' && validManagers.has(manager)) {
        result.set(cp, manager);
      }
    }
  } catch (err: any) {
    log.print(`[import_pricing_schedule] LLM 兜底分类失败（降级为空）: ${err?.message ?? err}`);
  }
  return result;
}

export async function importPricingSchedule(filePath: string, dryRun: boolean = true): Promise<{
  success: true;
  imported: number;
  skipped_products: number;
  details: string[];
  unmatched_products: Array<{ counterparty: string; suggestions: UnmatchedProductSuggestion[] }>;
  missing_clients: Array<{ manager: string; products: string[] }>;
  action_required?: string;
} | { success: false; error: string }> {
  const resolved = filePath.startsWith('~/')
    ? path.join(process.env.HOME || '', filePath.slice(1))
    : path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    return { success: false, error: `文件不存在: ${resolved}` };
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.readFile(resolved);
  } catch (e: any) {
    return { success: false, error: `Excel解析失败: ${e.message}` };
  }

  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    return { success: false, error: `Sheet不存在: ${sheetName}` };
  }

  const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(worksheet);
  if (rows.length === 0) {
    return { success: false, error: 'Excel文件为空' };
  }

  const db = getDb();

  // 产品 → 管理人映射（来自 config/customers.json）
  const customers = loadCustomers();
  const productToManager = new Map<string, string>(); // UPPER(counter_party) → manager name
  const allProducts: Array<{ counter_party: string; manager: string }> = [];
  for (const c of customers) {
    for (const p of c.products) {
      productToManager.set(p.counter_party.toUpperCase(), c.name);
      allProducts.push({ counter_party: p.counter_party, manager: c.name });
    }
  }

  // 客户表：name(ci) → row
  const allClients = db.prepare('SELECT id, name, tags, is_ft FROM clients').all() as { id: string; name: string; tags: string | null; is_ft: number }[];
  const clientByName = new Map<string, { id: string; name: string; tags: string | null; is_ft: number }>();
  for (const c of allClients) {
    clientByName.set(c.name.toUpperCase(), c);
  }

  const BP_FIELDS_XLSX = new Set(['Commission', 'Commission Cost', 'Net Comm']);
  const FIELD_MAP: Record<string, keyof PricingRange> = {
    'Long Financing Spread': 'long_financing_spread',
    'Short Financing': 'short_financing',
    'Commission': 'commission',
    'Commission Cost': 'commission_cost',
    'Net Comm': 'net_comm',
  };
  const NUMERIC_FIELDS: Array<keyof PricingRange> = [
    'long_financing_spread', 'short_financing', 'commission', 'commission_cost', 'net_comm',
  ];

  function matchProductToManager(counterparty: string): { manager: string; matchedProduct: string } | null {
    const upper = counterparty.toUpperCase();
    const direct = productToManager.get(upper);
    if (direct) return { manager: direct, matchedProduct: counterparty };
    // 模糊匹配：在所有 counter_party 中找 top1，score >= 0.6 接受
    let best: { counter_party: string; manager: string; score: number } | null = null;
    for (const p of allProducts) {
      const s = productStringSimilarity(counterparty, p.counter_party);
      if (!best || s > best.score) best = { counter_party: p.counter_party, manager: p.manager, score: s };
    }
    if (best && best.score >= 0.6) return { manager: best.manager, matchedProduct: best.counter_party };
    return null;
  }

  function topProductSuggestions(counterparty: string, topN: number = 3): UnmatchedProductSuggestion[] {
    const scored = allProducts.map(p => ({
      counter_party: p.counter_party,
      manager: p.manager,
      score: productStringSimilarity(counterparty, p.counter_party),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN).filter(s => s.score > 0.3).map(s => ({ counter_party: s.counter_party, manager: s.manager, source: 'heuristic' as const }));
  }

  // 聚合器：按管理人分组
  interface Aggregate {
    manager: string;
    products: string[];
    fieldValues: Record<string, number[]>;
    indexHedging: boolean;
  }
  const aggregates = new Map<string, Aggregate>(); // UPPER(manager) → aggregate

  const details: string[] = [];
  const unmatchedProducts: Array<{ counterparty: string; suggestions: UnmatchedProductSuggestion[] }> = [];
  const reportedUnmatched = new Set<string>();

  for (const row of rows) {
    const counterparty = String(row['Counterparty'] ?? '').trim();
    if (!counterparty) continue;

    const mapping = matchProductToManager(counterparty);
    if (!mapping) {
      if (!reportedUnmatched.has(counterparty.toUpperCase())) {
        reportedUnmatched.add(counterparty.toUpperCase());
        unmatchedProducts.push({ counterparty, suggestions: topProductSuggestions(counterparty) });
      }
      continue;
    }

    const managerKey = mapping.manager.toUpperCase();
    let agg = aggregates.get(managerKey);
    if (!agg) {
      agg = { manager: mapping.manager, products: [], fieldValues: {}, indexHedging: false };
      for (const f of NUMERIC_FIELDS) agg.fieldValues[f as string] = [];
      aggregates.set(managerKey, agg);
    }
    if (!agg.products.includes(counterparty)) agg.products.push(counterparty);

    for (const [xlsxCol, dbCol] of Object.entries(FIELD_MAP)) {
      const val = row[xlsxCol];
      if (val !== null && val !== undefined && val !== '') {
        const numRaw = Number(val);
        if (Number.isFinite(numRaw)) {
          const num = BP_FIELDS_XLSX.has(xlsxCol) ? numRaw * 0.0001 : numRaw;
          agg.fieldValues[dbCol as string].push(num);
        }
      }
    }

    const ih = row['Index Hedging?'];
    if (ih === true || ih === 'true' || ih === 1) agg.indexHedging = true;
  }

  // 启发式匹配已尽力，剩余 unmatched 交给 LLM 兜底分类。
  // 结果仅作为 suggestion 追加到 unmatched_products 里，不会改变 imported 数量，也不回写 customers.json。
  if (unmatchedProducts.length > 0) {
    const llmMap = await resolveUnmatchedByLLM(
      unmatchedProducts.map(u => u.counterparty),
      customers,
    );
    for (const u of unmatchedProducts) {
      const manager = llmMap.get(u.counterparty);
      if (!manager) continue;
      // 去掉启发式里同 manager 的重复项，把 LLM 建议放到最前
      u.suggestions = u.suggestions.filter(s => s.manager !== manager);
      u.suggestions.unshift({ counter_party: u.counterparty, manager, source: 'llm' });
    }
  }

  // 按管理人写入
  let imported = 0;
  const missingClients: Array<{ manager: string; products: string[] }> = [];

  const updateStmt = db.prepare(`
    UPDATE clients SET
      long_financing_spread = ?, short_financing = ?, commission = ?,
      commission_cost = ?, net_comm = ?, index_hedging = ?, pricing_range = ?, tags = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    for (const agg of aggregates.values()) {
      const client = clientByName.get(agg.manager.toUpperCase());
      if (!client) {
        missingClients.push({ manager: agg.manager, products: agg.products });
        continue;
      }

      // 计算每字段 min/max；全为空则 null
      const repr: Record<string, number | null> = {};
      const rangeObj: PricingRange = { products: agg.products };
      for (const f of NUMERIC_FIELDS) {
        const vals = agg.fieldValues[f as string];
        if (vals.length === 0) {
          repr[f as string] = null;
          (rangeObj as any)[f] = null;
        } else {
          const min = Math.min(...vals);
          const max = Math.max(...vals);
          repr[f as string] = min;
          (rangeObj as any)[f] = { min, max };
        }
      }

      const isFt = client.is_ft === 1;
      const category = classifyClient(isFt, repr.short_financing);

      const existingTags = client.tags ? client.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
      const categoryTags = existingTags.filter(t => t !== '多空客户' && t !== '中性客户');
      if (category) categoryTags.push(category);
      const newTags = categoryTags.join(',');

      const rangeJson = JSON.stringify(rangeObj);
      const indexHedgingVal = agg.indexHedging ? 1 : 0;

      if (!dryRun) {
        updateStmt.run(
          repr.long_financing_spread,
          repr.short_financing,
          repr.commission,
          repr.commission_cost,
          repr.net_comm,
          indexHedgingVal,
          rangeJson,
          newTags,
          client.id,
        );

        recordEvent('client', client.id, 'import_pricing', {
          source: path.basename(resolved),
          products: agg.products,
          category,
          ...repr,
          index_hedging: indexHedgingVal,
          pricing_range: rangeObj,
        });
      }

      imported++;
      const dryRunTag = dryRun ? ' [预览]' : '';
      const rangeSuffix = describeRangeSummary(rangeObj);
      details.push(`${agg.manager} ← ${agg.products.join(', ')} (${category ?? '未分类'})${rangeSuffix}${dryRunTag}`);
    }
  });

  tx();

  // 汇总未知产品和缺失客户的信息
  const actionNotes: string[] = [];

  if (unmatchedProducts.length > 0) {
    details.push('');
    details.push('⚠️ 以下产品未在 config/customers.json 中找到对应管理人，已跳过：');
    for (const u of unmatchedProducts) {
      const sug = u.suggestions.length > 0
        ? `（候选: ${u.suggestions.map(s => `${s.counter_party}→${s.manager}${s.source === 'llm' ? '[LLM]' : ''}`).join(', ')}）`
        : '';
      details.push(`  - ${u.counterparty}${sug}`);
    }
    details.push('禁止直接为这些产品调用 add_client 创建新客户！产品通常属于某个已有管理人（参考候选列表中的 manager）。');
    details.push('请先向用户确认：该产品属于哪个管理人？确认后由管理员在 config/customers.json 中维护产品 → 管理人映射，再重新导入。');
    actionNotes.push(
      '对 unmatched_products 绝不要直接调用 add_client。先询问用户：这些产品归属哪个已有管理人？'
      + '每个 suggestion 的 manager 字段为候选管理人；其中 source="llm" 为模型推断结果（高置信但仍需用户确认），source="heuristic" 为字符串相似度推断。'
      + '确认后需管理员在 config/customers.json 中补充映射后重新导入。',
    );
  }

  if (missingClients.length > 0) {
    details.push('');
    details.push('⚠️ 以下管理人已在 customers.json 中映射，但在客户表中不存在，已跳过：');
    for (const m of missingClients) {
      details.push(`  - ${m.manager}（涉及产品: ${m.products.join(', ')}）`);
    }
    details.push('请先通过 /client add 或 add_client 工具用**管理人名**创建客户，再重试导入。');
    actionNotes.push(
      '对 missing_clients 可使用 add_client 创建客户，但名称必须是管理人名（如"稳博"），不要使用产品名。',
    );
  }

  if (dryRun && imported > 0) {
    details.push('');
    details.push('⚠️ 以上为预览结果，未实际写入数据库。请确认后使用 dry_run=false 执行导入。');
  }

  return {
    success: true,
    imported,
    skipped_products: unmatchedProducts.length,
    details,
    unmatched_products: unmatchedProducts,
    missing_clients: missingClients,
    ...(actionNotes.length > 0 ? { action_required: actionNotes.join(' ') } : {}),
  };
}

function describeRangeSummary(range: PricingRange): string {
  const parts: string[] = [];
  for (const f of ['long_financing_spread', 'short_financing', 'commission', 'commission_cost', 'net_comm'] as const) {
    const v = range[f];
    if (v && v.min !== v.max) {
      const unit = BP_FIELDS_DB.has(f) ? 'bp' : '';
      const toStr = (n: number) => BP_FIELDS_DB.has(f) ? `${(n / 0.0001).toFixed(2)}` : `${n}`;
      parts.push(`${f}=${toStr(v.min)}~${toStr(v.max)}${unit}`);
    }
  }
  return parts.length > 0 ? ` [range: ${parts.join(', ')}]` : '';
}

// --- /client subcommand dispatcher ---

const ADMIN_SUBCMDS = new Set(['add', 'update', 'delete', 'advance', 'rollback', 'import-pricing']);

export async function handleClient(args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();
  const rest = parts.slice(1).join(' ');

  if (ADMIN_SUBCMDS.has(sub) && !isSystemAdmin()) {
    log.print('权限不足：该命令需要系统管理员权限');
    return;
  }

  switch (sub) {
    case 'list':    return list(rest);
    case 'view':    return view(rest);
    case 'history': return history(rest);
    case 'add':     return add(rest);
    case 'update':  return update(rest);
    case 'delete':  return remove(rest);
    case 'advance': return advance(rest);
    case 'rollback': return rollback(rest);
    case 'import-pricing': return handleImportPricingCLI(rest);
    default:
      log.print('用法: /client <list|view|history|add|update|delete|advance|rollback|import-pricing> [参数]');
  }
}

async function handleImportPricingCLI(args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const filePath = parts[0];
  if (!filePath) {
    log.print('用法: /client import-pricing <xlsx文件路径> [--confirm]');
    return;
  }
  const confirm = parts.includes('--confirm');
  const result = await importPricingSchedule(filePath, !confirm);
  if (!result.success) {
    log.print(`导入失败: ${result.error}`);
    return;
  }
  const mode = confirm ? '实际导入' : '预览';
  log.print(`报价${mode}完成: 成功 ${result.imported} 条管理人${result.skipped_products > 0 ? `, 未知产品 ${result.skipped_products} 个` : ''}${result.missing_clients.length > 0 ? `, 缺失客户 ${result.missing_clients.length} 个` : ''}`);
  for (const d of result.details) {
    log.print(`  ${d}`);
  }
}
