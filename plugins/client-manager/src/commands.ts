import { v4 as uuid } from 'uuid';
import XLSX from 'xlsx';
import * as path from 'path';
import * as fs from 'fs';
import type Database from 'better-sqlite3';
import { Client, ClientState, STATE_LABELS, STATES, nextState, prevState, classifyClient } from './model.js';
import { loadCustomers, type Customer } from './config.js';

// --- Event recording (plugin-local) ---

export function recordClientEvent(
  db: Database.Database,
  clientId: string,
  action: string,
  payload: Record<string, any> | undefined,
  userId: string,
  userName: string,
): void {
  db.prepare(
    'INSERT INTO client_events (id, client_id, action, payload, performed_by, performed_by_name) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(uuid(), clientId, action, payload ? JSON.stringify(payload) : null, userId, userName);
}

export function getClientEvents(db: Database.Database, clientId: string) {
  return db.prepare(
    'SELECT * FROM client_events WHERE client_id = ? ORDER BY created_at ASC'
  ).all(clientId) as Array<{ id: string; client_id: string; action: string; payload: string | null; performed_by: string; performed_by_name: string; created_at: string }>;
}

// --- Client lookup ---

export function findByPrefix(db: Database.Database, prefix: string): Client | null {
  let rows = db.prepare('SELECT * FROM clients WHERE name LIKE ? COLLATE NOCASE').all(`%${prefix}%`) as Client[];
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) {
    const exact = rows.find(r => r.name.toLowerCase() === prefix.toLowerCase());
    if (exact) return exact;
    return null;
  }
  rows = db.prepare('SELECT * FROM clients WHERE id LIKE ?').all(`${prefix}%`) as Client[];
  if (rows.length === 1) return rows[0];
  return null;
}

// --- Data functions ---

export function fetchClients(db: Database.Database, filter?: { state?: string; keyword?: string }): Client[] {
  let sql = 'SELECT * FROM clients';
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter?.state) {
    conditions.push('state = ?');
    params.push(filter.state);
  }
  if (filter?.keyword) {
    conditions.push("(name LIKE ? COLLATE NOCASE OR wework_group LIKE ? COLLATE NOCASE OR tags LIKE ? COLLATE NOCASE)");
    const kw = `%${filter.keyword}%`;
    params.push(kw, kw, kw);
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  return db.prepare(sql).all(...params) as Client[];
}

export function fetchClient(db: Database.Database, nameOrId: string): Client | null {
  return findByPrefix(db, nameOrId);
}

export function fetchHistory(db: Database.Database, nameOrId: string): { name: string; events: ReturnType<typeof getClientEvents> } | null {
  const client = findByPrefix(db, nameOrId);
  if (!client) return null;
  return { name: client.name, events: getClientEvents(db, client.id) };
}

export function createClient(
  db: Database.Database,
  input: { name: string; contact?: string; wework_group?: string; requirements?: string; sales?: string; notes?: string },
  userId: string,
  userName: string,
): { success: true; id: string; name: string } | { success: false; error: string } {
  const id = uuid();
  db.prepare(
    'INSERT INTO clients (id, name, contact, wework_group, requirements, sales, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, input.name, input.contact ?? null, input.wework_group ?? null, input.requirements ?? null, input.sales ?? null, input.notes ?? null, userId);

  recordClientEvent(db, id, 'create', input, userId, userName);
  return { success: true, id: id.slice(0, 8), name: input.name };
}

export function updateClient(
  db: Database.Database,
  nameOrId: string,
  fields: Record<string, string>,
  userId: string,
  userName: string,
): { success: true; name: string } | { success: false; error: string } {
  if ('state' in fields) return { success: false, error: '不允许通过 update 修改 state，请使用 advance 命令推进状态' };

  const client = findByPrefix(db, nameOrId);
  if (!client) return { success: false, error: `未找到客户: ${nameOrId}` };

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
  recordClientEvent(db, client.id, 'update', fields, userId, userName);
  return { success: true, name: client.name };
}

export function advanceClient(
  db: Database.Database,
  nameOrId: string,
  userId: string,
  userName: string,
): { success: true; name: string; from: string; to: string } | { success: false; error: string } {
  const client = findByPrefix(db, nameOrId);
  if (!client) return { success: false, error: `未找到客户: ${nameOrId}` };

  const next = nextState(client.state);
  if (!next) return { success: false, error: `客户 ${client.name} 已处于最终状态: ${STATE_LABELS[client.state]}` };

  db.prepare("UPDATE clients SET state = ?, updated_at = datetime('now') WHERE id = ?").run(next, client.id);
  recordClientEvent(db, client.id, 'advance', { from: client.state, to: next }, userId, userName);
  return { success: true, name: client.name, from: STATE_LABELS[client.state], to: STATE_LABELS[next] };
}

export function rollbackClient(
  db: Database.Database,
  nameOrId: string,
  userId: string,
  userName: string,
): { success: true; name: string; from: string; to: string } | { success: false; error: string } {
  const client = findByPrefix(db, nameOrId);
  if (!client) return { success: false, error: `未找到客户: ${nameOrId}` };

  const prev = prevState(client.state);
  if (!prev) return { success: false, error: `客户 ${client.name} 已处于初始状态: ${STATE_LABELS[client.state]}` };

  db.prepare("UPDATE clients SET state = ?, updated_at = datetime('now') WHERE id = ?").run(prev, client.id);
  recordClientEvent(db, client.id, 'rollback', { from: client.state, to: prev }, userId, userName);
  return { success: true, name: client.name, from: STATE_LABELS[client.state], to: STATE_LABELS[prev] };
}

export function deleteClient(
  db: Database.Database,
  nameOrId: string,
  dryRun: boolean,
  userId: string,
  userName: string,
):
  | { success: true; dry_run: boolean; id: string; name: string; state: string; tags: string | null; deleted?: boolean }
  | { success: false; error: string } {
  const client = findByPrefix(db, nameOrId);
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

  db.prepare('DELETE FROM clients WHERE id = ?').run(client.id);
  recordClientEvent(db, client.id, 'delete', { name: client.name }, userId, userName);
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

// --- Pricing helpers ---

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

export function formatFieldWithRange(value: number | null, range?: PricingRangeField | null): string {
  if (value === null || value === undefined) return '-';
  if (!range || range.min === range.max) return String(value);
  return `${value} (range: ${range.min} ~ ${range.max})`;
}

// --- Import Pricing Schedule ---

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

export interface ImportPricingOptions {
  filePath: string;
  dryRun?: boolean;
  resolveLLM?: (pending: string[], customers: Customer[]) => Promise<Map<string, string>>;
}

const BP_FIELDS_DB = new Set(['commission', 'commission_cost', 'net_comm']);

export async function importPricingSchedule(
  db: Database.Database,
  options: ImportPricingOptions,
  userId: string,
  userName: string,
): Promise<{
  success: true;
  imported: number;
  skipped_products: number;
  details: string[];
  unmatched_products: Array<{ counterparty: string; suggestions: UnmatchedProductSuggestion[] }>;
  missing_clients: Array<{ manager: string; products: string[] }>;
  action_required?: string;
} | { success: false; error: string }> {
  const { filePath, dryRun = true, resolveLLM } = options;
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

  const customers = loadCustomers();
  const productToManager = new Map<string, string>();
  const allProducts: Array<{ counter_party: string; manager: string }> = [];
  for (const c of customers) {
    for (const p of c.products) {
      productToManager.set(p.counter_party.toUpperCase(), c.name);
      allProducts.push({ counter_party: p.counter_party, manager: c.name });
    }
  }

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
    let best: { counter_party: string; manager: string; score: number } | null = null;
    for (const p of allProducts) {
      const s = productStringSimilarity(counterparty, p.counter_party);
      if (!best || s > best.score) best = { counter_party: p.counter_party, manager: p.manager, score: s };
    }
    if (best && best.score >= 0.6) return { manager: best.manager, matchedProduct: best.counter_party };
    return null;
  }

  function topProductSuggestions(counterparty: string, topN = 3): UnmatchedProductSuggestion[] {
    const scored = allProducts.map(p => ({
      counter_party: p.counter_party,
      manager: p.manager,
      score: productStringSimilarity(counterparty, p.counter_party),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN).filter(s => s.score > 0.3).map(s => ({ counter_party: s.counter_party, manager: s.manager, source: 'heuristic' as const }));
  }

  interface Aggregate {
    manager: string;
    products: string[];
    fieldValues: Record<string, number[]>;
    indexHedging: boolean;
  }
  const aggregates = new Map<string, Aggregate>();

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

  // LLM fallback for unmatched products
  if (unmatchedProducts.length > 0 && resolveLLM) {
    const llmMap = await resolveLLM(
      unmatchedProducts.map(u => u.counterparty),
      customers,
    );
    for (const u of unmatchedProducts) {
      const manager = llmMap.get(u.counterparty);
      if (!manager) continue;
      u.suggestions = u.suggestions.filter(s => s.manager !== manager);
      u.suggestions.unshift({ counter_party: u.counterparty, manager, source: 'llm' });
    }
  }

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

        recordClientEvent(db, client.id, 'import_pricing', {
          source: path.basename(resolved),
          products: agg.products,
          category,
          ...repr,
          index_hedging: indexHedgingVal,
          pricing_range: rangeObj,
        }, userId, userName);
      }

      imported++;
      const dryRunTag = dryRun ? ' [预览]' : '';
      const rangeSuffix = describeRangeSummary(rangeObj);
      details.push(`${agg.manager} ← ${agg.products.join(', ')} (${category ?? '未分类'})${rangeSuffix}${dryRunTag}`);
    }
  });

  tx();

  const actionNotes: string[] = [];
  if (unmatchedProducts.length > 0) {
    details.push('');
    details.push('⚠️ 以下产品未在 customers.json 中找到对应管理人，已跳过：');
    for (const u of unmatchedProducts) {
      const sug = u.suggestions.length > 0
        ? `（候选: ${u.suggestions.map(s => `${s.counter_party}→${s.manager}${s.source === 'llm' ? '[LLM]' : ''}`).join(', ')}）`
        : '';
      details.push(`  - ${u.counterparty}${sug}`);
    }
    actionNotes.push('对 unmatched_products 绝不要直接调用 add_client。先询问用户：这些产品归属哪个已有管理人？');
  }

  if (missingClients.length > 0) {
    details.push('');
    details.push('⚠️ 以下管理人已在 customers.json 中映射，但在客户表中不存在，已跳过：');
    for (const m of missingClients) {
      details.push(`  - ${m.manager}（涉及产品: ${m.products.join(', ')}）`);
    }
    actionNotes.push('对 missing_clients 可使用 add_client 创建客户，但名称必须是管理人名。');
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
