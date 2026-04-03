import { getDb } from '../../db/connection.js';
import { getCurrentUser } from '../../auth/rbac.js';
import { v4 as uuid } from 'uuid';

export interface MemoryItem {
  id: string;
  agentId: string | null;
  scope: 'global' | 'agent';
  content: string;
  category: string | null;
  source: 'manual' | 'auto';
  createdBy: string;
  createdAt: string;
}

export interface MemoryRow {
  id: string;
  agent_id: string | null;
  scope: string;
  content: string;
  category: string | null;
  source: string;
  created_by: string;
  created_at: string;
}

function rowToItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    agentId: row.agent_id,
    scope: row.scope as MemoryItem['scope'],
    content: row.content,
    category: row.category,
    source: row.source as MemoryItem['source'],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const MAX_MEMORY_PER_SCOPE = 100;
const MAX_CONTENT_LENGTH = 500;

/** Fetch global memory + agent-specific memory */
export function fetchMemory(agentId?: string): MemoryItem[] {
  const db = getDb();
  const global = db.prepare(
    "SELECT * FROM memory WHERE scope = 'global' ORDER BY created_at DESC LIMIT ?"
  ).all(MAX_MEMORY_PER_SCOPE) as MemoryRow[];

  let agentItems: MemoryRow[] = [];
  if (agentId) {
    agentItems = db.prepare(
      "SELECT * FROM memory WHERE scope = 'agent' AND agent_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(agentId, MAX_MEMORY_PER_SCOPE) as MemoryRow[];
  }

  return [...global.map(rowToItem), ...agentItems.map(rowToItem)];
}

/** Search memory by keyword */
export function searchMemory(keyword: string, agentId?: string): MemoryItem[] {
  const db = getDb();
  const pattern = `%${keyword}%`;

  if (agentId) {
    const rows = db.prepare(
      "SELECT * FROM memory WHERE content LIKE ? AND (scope = 'global' OR agent_id = ?) ORDER BY created_at DESC LIMIT 50"
    ).all(pattern, agentId) as MemoryRow[];
    return rows.map(rowToItem);
  }

  const rows = db.prepare(
    "SELECT * FROM memory WHERE content LIKE ? ORDER BY created_at DESC LIMIT 50"
  ).all(pattern) as MemoryRow[];
  return rows.map(rowToItem);
}

export interface SaveMemoryInput {
  content: string;
  scope?: 'global' | 'agent';
  agentId?: string;
  category?: string;
  source?: 'manual' | 'auto';
}

/** Save a memory item */
export function saveMemory(input: SaveMemoryInput): { success: true; id: string } | { success: false; error: string } {
  if (!input.content || input.content.trim().length === 0) {
    return { success: false, error: '记忆内容不能为空' };
  }
  if (input.content.length > MAX_CONTENT_LENGTH) {
    return { success: false, error: `记忆内容过长，最大 ${MAX_CONTENT_LENGTH} 字符` };
  }

  const scope = input.scope ?? 'global';
  const agentId = scope === 'agent' ? (input.agentId ?? null) : null;

  if (scope === 'agent' && !agentId) {
    return { success: false, error: 'agent 范围的记忆需要指定 agentId' };
  }

  // Check limit
  const db = getDb();
  const countQuery = scope === 'global'
    ? db.prepare("SELECT COUNT(*) as c FROM memory WHERE scope = 'global'")
    : db.prepare("SELECT COUNT(*) as c FROM memory WHERE scope = 'agent' AND agent_id = ?");
  const count = (scope === 'global' ? countQuery.get() : countQuery.get(agentId)) as { c: number };

  if (count.c >= MAX_MEMORY_PER_SCOPE) {
    // Evict oldest
    const evictQuery = scope === 'global'
      ? db.prepare("DELETE FROM memory WHERE id = (SELECT id FROM memory WHERE scope = 'global' ORDER BY created_at ASC LIMIT 1)")
      : db.prepare("DELETE FROM memory WHERE id = (SELECT id FROM memory WHERE scope = 'agent' AND agent_id = ? ORDER BY created_at ASC LIMIT 1)");
    if (scope === 'global') evictQuery.run(); else evictQuery.run(agentId);
  }

  const user = getCurrentUser();
  const id = uuid();
  db.prepare(
    'INSERT INTO memory (id, agent_id, scope, content, category, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, agentId, scope, input.content.trim(), input.category ?? null, input.source ?? 'manual', user.id);

  return { success: true, id: id.slice(0, 8) };
}

/** Find a memory row by id prefix (for ownership checks before update/delete) */
export function getMemoryByIdPrefix(idPrefix: string): MemoryRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM memory WHERE id LIKE ?").get(`${idPrefix}%`) as MemoryRow | undefined;
}

/** Update content/category of a memory item by id prefix */
export function updateMemory(
  idPrefix: string,
  updates: { content?: string; category?: string }
): { success: true } | { success: false; error: string } {
  if (!updates.content && !updates.category) {
    return { success: false, error: '至少提供 content 或 category 之一' };
  }
  if (updates.content && updates.content.length > MAX_CONTENT_LENGTH) {
    return { success: false, error: `内容过长，最大 ${MAX_CONTENT_LENGTH} 字符` };
  }
  const row = getMemoryByIdPrefix(idPrefix);
  if (!row) return { success: false, error: `未找到记忆: ${idPrefix}` };
  const db = getDb();
  if (updates.content && updates.category) {
    db.prepare('UPDATE memory SET content = ?, category = ? WHERE id = ?').run(updates.content.trim(), updates.category, row.id);
  } else if (updates.content) {
    db.prepare('UPDATE memory SET content = ? WHERE id = ?').run(updates.content.trim(), row.id);
  } else {
    db.prepare('UPDATE memory SET category = ? WHERE id = ?').run(updates.category!, row.id);
  }
  return { success: true };
}

/** Delete a memory item by id prefix */
export function deleteMemory(idPrefix: string): { success: true } | { success: false; error: string } {
  const row = getMemoryByIdPrefix(idPrefix);
  if (!row) return { success: false, error: `未找到记忆: ${idPrefix}` };
  const db = getDb();
  db.prepare('DELETE FROM memory WHERE id = ?').run(row.id);
  return { success: true };
}

/** Get all memory items (for CLI listing) */
export function listAllMemory(agentId?: string): MemoryItem[] {
  const db = getDb();
  if (agentId) {
    const rows = db.prepare('SELECT * FROM memory WHERE scope = ? OR agent_id = ? ORDER BY scope, created_at DESC').all('global', agentId) as MemoryRow[];
    return rows.map(rowToItem);
  }
  const rows = db.prepare('SELECT * FROM memory ORDER BY scope, created_at DESC').all() as MemoryRow[];
  return rows.map(rowToItem);
}

/**
 * Build a formatted memory block for injection into system prompt.
 * Returns empty string if no memory exists.
 */
export function buildMemoryBlock(agentId?: string): string {
  const db = getDb();

  const globalRows = db.prepare(
    "SELECT content FROM memory WHERE scope = 'global' ORDER BY created_at DESC LIMIT 50"
  ).all() as { content: string }[];

  let agentRows: { content: string }[] = [];
  if (agentId) {
    agentRows = db.prepare(
      "SELECT content FROM memory WHERE scope = 'agent' AND agent_id = ? ORDER BY created_at DESC LIMIT 30"
    ).all(agentId) as { content: string }[];
  }

  if (globalRows.length === 0 && agentRows.length === 0) return '';

  const parts: string[] = ['## 记忆（重要上下文，请在回答时参考）'];

  if (globalRows.length > 0) {
    parts.push('### 全局记忆');
    parts.push(...globalRows.map(r => `- ${r.content}`));
  }

  if (agentRows.length > 0) {
    parts.push('### 当前 Agent 记忆');
    parts.push(...agentRows.map(r => `- ${r.content}`));
  }

  return parts.join('\n');
}
