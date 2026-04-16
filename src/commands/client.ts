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
    'long_financing_spread', 'short_financing', 'commission', 'commission_cost', 'net_comm', 'index_hedging', 'is_ft'];
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
  log.print(`  Long Financing Spread: ${client.long_financing_spread ?? '-'}`);
  log.print(`  Short Financing:       ${client.short_financing ?? '-'}`);
  log.print(`  Commission:            ${client.commission ?? '-'}`);
  log.print(`  Commission Cost:       ${client.commission_cost ?? '-'}`);
  log.print(`  Net Comm:              ${client.net_comm ?? '-'}`);
  log.print(`  Index Hedging:         ${client.index_hedging === 1 ? '是' : client.index_hedging === 0 ? '否' : '-'}`);
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
    'long_financing_spread', 'short_financing', 'commission', 'commission_cost', 'net_comm', 'index_hedging', 'is_ft'];
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

export function importPricingSchedule(filePath: string, dryRun: boolean = true): { success: true; imported: number; skipped: number; details: string[]; unmatched: Array<{ counterparty: string; suggestions: string[] }> } | { success: false; error: string } {
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
  const allClients = db.prepare('SELECT id, name, tags, is_ft, short_financing FROM clients').all() as { id: string; name: string; tags: string | null; is_ft: number; short_financing: number | null }[];
  const clientNameMap = new Map<string, { id: string; name: string; tags: string | null; is_ft: number; short_financing: number | null }>();
  for (const c of allClients) {
    clientNameMap.set(c.name.toUpperCase(), c);
  }

  const IGNORED_COLS = new Set(['Long PNL Spread', 'Short PNL Spread']);

  const BP_FIELDS = new Set(['Commission', 'Commission Cost', 'Net Comm']);

  const FIELD_MAP: Record<string, string> = {
    'Long Financing Spread': 'long_financing_spread',
    'Short Financing': 'short_financing',
    'Commission': 'commission',
    'Commission Cost': 'commission_cost',
    'Net Comm': 'net_comm',
  };

  function similarity(a: string, b: string): number {
    const s1 = a.toLowerCase();
    const s2 = b.toLowerCase();
    if (s1 === s2) return 1;
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;
    const len = Math.max(s1.length, s2.length);
    let matches = 0;
    for (let i = 0; i < Math.min(s1.length, s2.length); i++) {
      if (s1[i] === s2[i]) matches++;
    }
    return matches / len;
  }

  function findTopSuggestions(counterparty: string, clients: { name: string }[], topN: number = 3): string[] {
    const scored = clients.map(c => ({ name: c.name, score: similarity(counterparty, c.name) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN).filter(s => s.score > 0.2).map(s => s.name);
  }

  let imported = 0;
  let skipped = 0;
  const details: string[] = [];
  const unmatched: Array<{ counterparty: string; suggestions: string[] }> = [];

  const updateStmt = db.prepare(`
    UPDATE clients SET
      long_financing_spread = ?, short_financing = ?, commission = ?,
      commission_cost = ?, net_comm = ?, index_hedging = ?, tags = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      const counterparty = String(row['Counterparty'] ?? '').trim();
      if (!counterparty) continue;

      const matched = clientNameMap.get(counterparty.toUpperCase());
      if (!matched) {
        skipped++;
        const suggestions = findTopSuggestions(counterparty, allClients);
        unmatched.push({ counterparty, suggestions });
        details.push(`${counterparty}: 未找到匹配客户${suggestions.length > 0 ? `，推荐: ${suggestions.join(', ')}` : ''}`);
        continue;
      }

      const indexHedging = row['Index Hedging?'];
      const indexHedgingVal = indexHedging === true || indexHedging === 'true' || indexHedging === 1 ? 1 : 0;

      const fields: Record<string, number | null> = {};
      for (const [xlsxCol, dbCol] of Object.entries(FIELD_MAP)) {
        const val = row[xlsxCol];
        if (val !== null && val !== undefined && val !== '') {
          const numVal = Number(val);
          fields[dbCol] = BP_FIELDS.has(xlsxCol) ? numVal * 0.0001 : numVal;
        } else {
          fields[dbCol] = null;
        }
      }

      const isFt = matched.is_ft === 1;
      const shortFinancing = fields.short_financing ?? matched.short_financing;
      const category = classifyClient(isFt, shortFinancing);

      const existingTags = matched.tags ? matched.tags.split(',').map(t => t.trim()) : [];
      const categoryTags = existingTags.filter(t => t !== '多空客户' && t !== '中性客户');
      if (category) categoryTags.push(category);
      const newTags = categoryTags.join(',');

      if (!dryRun) {
        updateStmt.run(
          fields.long_financing_spread,
          fields.short_financing,
          fields.commission,
          fields.commission_cost,
          fields.net_comm,
          indexHedgingVal,
          newTags,
          matched.id,
        );

        recordEvent('client', matched.id, 'import_pricing', {
          source: path.basename(resolved),
          counterparty,
          category,
          ...fields,
          index_hedging: indexHedgingVal,
        });
      }

      imported++;
      const dryRunTag = dryRun ? ' [预览]' : '';
      details.push(`${counterparty} → ${matched.name} (${category ?? '未分类'})${dryRunTag}`);
    }
  });

  tx();

  if (dryRun && imported > 0) {
    details.push('');
    details.push('⚠️ 以上为预览结果，未实际写入数据库。请确认后使用 dry_run=false 执行导入。');
  }

  return { success: true, imported, skipped, details, unmatched };
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

function handleImportPricingCLI(args: string): void {
  const parts = args.trim().split(/\s+/);
  const filePath = parts[0];
  if (!filePath) {
    log.print('用法: /client import-pricing <xlsx文件路径> [--confirm]');
    return;
  }
  const confirm = parts.includes('--confirm');
  const result = importPricingSchedule(filePath, !confirm);
  if (!result.success) {
    log.print(`导入失败: ${result.error}`);
    return;
  }
  const mode = confirm ? '实际导入' : '预览';
  log.print(`报价${mode}完成: 成功 ${result.imported} 条, 跳过 ${result.skipped} 条`);
  for (const d of result.details) {
    log.print(`  ${d}`);
  }
}
