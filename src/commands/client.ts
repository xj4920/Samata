import { getDb } from '../db/connection.js';
import { getCurrentUser } from '../auth/rbac.js';
import { recordEvent, getEvents } from '../models/event.js';
import { Client, ClientState, STATE_LABELS, STATES, nextState } from '../models/client.js';
import { log } from '../utils/logger.js';
import { renderTable } from '../utils/table.js';
import { v4 as uuid } from 'uuid';

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
    log.warn('用法: add <名称> [contact=xx] [wework_group=xx] [sales=xx] [notes=xx]');
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
  log.success(`客户已添加: ${name} (${id.slice(0, 8)})`);
}

export function update(args: string): void {
  const parts = args.match(/^(\S+)\s+(.*)/);
  if (!parts) {
    log.warn('用法: update <id> <field=value ...>');
    return;
  }
  const idPrefix = parts[1];
  const kv = parseKV(parts[2]);
  if (Object.keys(kv).length === 0) {
    log.warn('请提供要更新的字段，如: name=xx wework_group=xx');
    return;
  }

  const db = getDb();
  const client = findByPrefix(idPrefix);
  if (!client) return;

  const allowed = ['name', 'contact', 'wework_group', 'requirements', 'sales', 'tags', 'notes'];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(kv)) {
    if (!allowed.includes(k)) {
      log.warn(`不支持更新字段: ${k}`);
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
  log.success(`客户已更新: ${client.name}`);
}

export function remove(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.warn('用法: delete <id>');
    return;
  }
  const client = findByPrefix(idPrefix);
  if (!client) return;

  const db = getDb();
  db.prepare('DELETE FROM clients WHERE id = ?').run(client.id);
  recordEvent('client', client.id, 'delete', { name: client.name });
  log.success(`客户已删除: ${client.name}`);
}

export function advance(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.warn('用法: advance <id>');
    return;
  }
  const client = findByPrefix(idPrefix);
  if (!client) return;

  const next = nextState(client.state);
  if (!next) {
    log.warn(`客户 ${client.name} 已处于最终状态: ${STATE_LABELS[client.state]}`);
    return;
  }

  const db = getDb();
  db.prepare("UPDATE clients SET state = ?, updated_at = datetime('now') WHERE id = ?").run(next, client.id);
  recordEvent('client', client.id, 'advance', { from: client.state, to: next });
  log.success(`${client.name}: ${STATE_LABELS[client.state]} → ${STATE_LABELS[next]}`);
}

export function list(args: string): void {
  const db = getDb();
  const kv = parseKV(args);
  let sql = 'SELECT * FROM clients';
  const params: any[] = [];

  if (kv.state && STATES.includes(kv.state as ClientState)) {
    sql += ' WHERE state = ?';
    params.push(kv.state);
  }
  sql += ' ORDER BY updated_at DESC';

  const rows = db.prepare(sql).all(...params) as Client[];
  if (rows.length === 0) {
    log.dim('暂无客户数据');
    return;
  }

  // 根据终端宽度决定显示哪些列
  const termWidth = process.stdout.columns || 120;

  // 所有列定义：key, header, width, extract
  const allCols: { key: string; header: string; minWidth: number; extract: (c: Client) => string }[] = [
    { key: 'id',       header: 'ID',          minWidth: 12, extract: c => c.id.slice(0, 8) },
    { key: 'name',     header: '名称',        minWidth: 15, extract: c => c.name },
    { key: 'state',    header: '状态',        minWidth: 18, extract: c => STATE_LABELS[c.state] || c.state },
    { key: 'sales',    header: '销售',        minWidth: 12, extract: c => c.sales ?? '-' },
    { key: 'tags',     header: '标签',        minWidth: 14, extract: c => c.tags ?? '-' },
    { key: 'updated',  header: '更新时间',    minWidth: 20, extract: c => c.updated_at },
    { key: 'req',      header: '需求',        minWidth: 15, extract: c => c.requirements ?? '-' },
    { key: 'wework',   header: 'WeWork Group', minWidth: 15, extract: c => c.wework_group ?? '-' },
    { key: 'notes',    header: '备注',        minWidth: 12, extract: c => c.notes ?? '-' },
  ];

  // 从右侧开始裁剪列，直到总宽度适配终端
  let visibleCols = [...allCols];
  const borderOf = (n: number) => n + 1; // cli-table3 边框开销
  while (visibleCols.length > 2) {
    const totalMin = visibleCols.reduce((s, col) => s + col.minWidth, 0) + borderOf(visibleCols.length);
    if (totalMin <= termWidth) break;
    visibleCols.pop(); // 移除最右列
  }

  const head = visibleCols.map(col => col.header);
  const tableRows = rows.map(c => visibleCols.map(col => col.extract(c)));

  // 名称列动态扩展
  const nameIdx = visibleCols.findIndex(col => col.key === 'name');
  const colWidths = visibleCols.map((col, i) => {
    if (i === nameIdx) {
      const maxLen = Math.max(col.header.length, ...tableRows.map(row => row[i].length));
      return Math.min(Math.max(maxLen + 4, col.minWidth), 30);
    }
    return col.minWidth;
  });

  // 剩余空间按比例分配给可伸缩列（需求、WeWork Group、备注）
  const flexKeys = ['req', 'wework', 'notes'];
  const usedWidth = colWidths.reduce((s, w) => s + w, 0) + borderOf(visibleCols.length);
  const extraSpace = termWidth - usedWidth;
  if (extraSpace > 0) {
    const flexIndices = visibleCols.map((col, i) => flexKeys.includes(col.key) ? i : -1).filter(i => i >= 0);
    if (flexIndices.length > 0) {
      const each = Math.floor(extraSpace / flexIndices.length);
      for (const fi of flexIndices) colWidths[fi] += each;
    }
  }

  const cols = colWidths.map(width => ({ width }));

  renderTable(head, tableRows, cols);
  log.dim(`共 ${rows.length} 条`);
}

export function view(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.warn('用法: view <id>');
    return;
  }
  const client = findByPrefix(idPrefix);
  if (!client) return;

  console.log(`  ID:         ${client.id}`);
  console.log(`  名称:       ${client.name}`);
  console.log(`  WeWork Group: ${client.wework_group ?? '-'}`);
  console.log(`  需求:       ${client.requirements ?? '-'}`);
  console.log(`  销售:       ${client.sales ?? '-'}`);
  console.log(`  联系方式:   ${client.contact ?? '-'}`);
  console.log(`  状态:       ${STATE_LABELS[client.state]}`);
  console.log(`  标签:       ${client.tags ?? '-'}`);
  console.log(`  备注:       ${client.notes ?? '-'}`);
  console.log(`  创建时间:   ${client.created_at}`);
  console.log(`  更新时间:   ${client.updated_at}`);
}

export function history(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.warn('用法: history <id>');
    return;
  }
  const client = findByPrefix(idPrefix);
  if (!client) return;

  const events = getEvents(client.id);
  if (events.length === 0) {
    log.dim('暂无操作记录');
    return;
  }

  log.info(`${client.name} 的操作历史：`);
  for (const e of events) {
    const payload = e.payload ? ` ${e.payload}` : '';
    console.log(`  ${e.created_at}  ${e.action.padEnd(10)}${payload}`);
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
    log.warn(`匹配到多个客户，请提供更长的ID前缀：`);
    for (const c of rows) {
      console.log(`  ${c.id.slice(0, 8)}  ${c.name}`);
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
    conditions.push('(name LIKE ? COLLATE NOCASE OR wework_group LIKE ? COLLATE NOCASE)');
    params.push(`%${filter.keyword}%`, `%${filter.keyword}%`);
  }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY updated_at DESC';

  return db.prepare(sql).all(...params) as Client[];
}

export function fetchClient(nameOrId: string): Client | null {
  return findByPrefix(nameOrId);
}

export function fetchHistory(nameOrId: string): { name: string; events: ReturnType<typeof getEvents> } | null {
  const client = findByPrefix(nameOrId);
  if (!client) return null;
  return { name: client.name, events: getEvents(client.id) };
}

export function addClient(args: string): { success: true; id: string; name: string } | { success: false; error: string } {
  const parts = args.match(/^(\S+)\s*(.*)/);
  if (!parts) return { success: false, error: '用法: /add <名称> [contact=xx] [wework_group=xx] [sales=xx] [notes=xx]' };
  const name = parts[1];
  const kv = parseKV(parts[2] || '');
  const db = getDb();
  const user = getCurrentUser();
  const id = uuid();

  db.prepare(
    'INSERT INTO clients (id, name, contact, wework_group, requirements, sales, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, name, kv.contact ?? null, kv.wework_group ?? null, kv.requirements ?? null, kv.sales ?? null, kv.notes ?? null, user.id);

  recordEvent('client', id, 'create', { name, ...kv });
  return { success: true, id: id.slice(0, 8), name };
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
