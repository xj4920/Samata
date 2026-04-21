import { getDb } from '../db/connection.js';
import { getCurrentUser, isAgentAdmin, isSystemAdmin } from '../auth/rbac.js';
import { getCurrentAgent } from '../llm/agent.js';
import { recordEvent } from '../models/event.js';
import { log } from '../utils/logger.js';
import { isInteractive, remoteInput } from '../runtime/execution-context.js';
import { v4 as uuid } from 'uuid';
import { grepSearchDocuments, type GrepSearchResult } from '../utils/grep-search.js';
import { BROAD_BUSINESS_TERMS, expandCJKKeywords } from '../utils/keyword-weights.js';

export interface KnowledgeItem {
  id: string;
  question: string;
  answer: string;
  tags: string | null;
  related_users: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  document_id?: string | null;
  relevance?: number;
}

/**
 * Structured dual-group search output.
 *
 * FAQ and document scores live on different scales (DB weighted LIKE vs. grep
 * line-count), so we deliberately keep them in separate arrays instead of
 * mixing and globally sorting.
 */
export interface KnowledgeSearchResult {
  faq: KnowledgeItem[];
  documents: GrepSearchResult[];
}

/** @deprecated kept for type hints where older single-list form is expected. */
export type SearchResult = KnowledgeItem | GrepSearchResult;

function ensureKnowledgeWriteAccess(agentId?: string, knowledgeId?: string): { success: true } | { success: false; error: string } {
  const db = getDb();

  if (agentId) {
    if (!isAgentAdmin(agentId)) {
      return { success: false, error: '权限不足：需要当前 Agent 的管理员权限' };
    }
    if (knowledgeId) {
      const assoc = db.prepare('SELECT 1 FROM knowledge_agents WHERE knowledge_id = ? AND agent_id = ?').get(knowledgeId, agentId);
      if (!assoc) {
        return { success: false, error: '权限不足：该知识条目不属于当前 Agent' };
      }
    }
    return { success: true };
  }

  if (!isSystemAdmin()) {
    return { success: false, error: '权限不足：需要系统管理员权限' };
  }
  return { success: true };
}

/** DB-only search for manual FAQ entries (document_id IS NULL) */
function searchFAQs(keyword: string, agentId?: string): KnowledgeItem[] {
  const db = getDb();
  const agentFilter = agentId
    ? 'AND k.id IN (SELECT knowledge_id FROM knowledge_agents WHERE agent_id = ?)'
    : '';
  const docFilter = 'AND k.document_id IS NULL';

  const rawKeywords = keyword.split(/\s+/).filter(Boolean);
  if (rawKeywords.length === 0) {
    if (agentId) {
      return db.prepare(
        `SELECT k.* FROM knowledge k WHERE k.id IN (SELECT knowledge_id FROM knowledge_agents WHERE agent_id = ?) ${docFilter} ORDER BY k.created_at DESC`
      ).all(agentId) as KnowledgeItem[];
    }
    return db.prepare(`SELECT k.* FROM knowledge k WHERE ${docFilter.slice(4)} ORDER BY k.created_at DESC`).all() as KnowledgeItem[];
  }

  const { primary, derived } = expandCJKKeywords(rawKeywords);
  const allTerms = [...primary, ...derived];

  type TermWeight = { q: number; t: number; a: number };
  const weights: TermWeight[] = allTerms.map((kw, i) => {
    if (i >= primary.length) return { q: 1, t: 1, a: 0 };
    if (BROAD_BUSINESS_TERMS.has(kw)) return { q: 1, t: 1, a: 0 };
    return { q: 3, t: 2, a: 1 };
  });

  const whereClauses = allTerms.map(() =>
    '(k.question LIKE ? OR k.answer LIKE ? OR k.tags LIKE ?)'
  ).join(' OR ');

  const scoreExpr = weights.map(w =>
    `(CASE WHEN k.question LIKE ? THEN ${w.q} ELSE 0 END) + ` +
    `(CASE WHEN k.tags LIKE ? THEN ${w.t} ELSE 0 END) + ` +
    `(CASE WHEN k.answer LIKE ? THEN ${w.a} ELSE 0 END)`
  ).join(' + ');

  const sql = `SELECT k.*, (${scoreExpr}) as relevance FROM knowledge k WHERE (${whereClauses}) ${docFilter} ${agentFilter} ORDER BY relevance DESC, k.created_at DESC LIMIT 10`;

  const params: string[] = [];
  for (const kw of allTerms) {
    params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
  }
  for (const kw of allTerms) {
    params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
  }
  if (agentId) params.push(agentId);

  return db.prepare(sql).all(...params) as KnowledgeItem[];
}

const FAQ_LIMIT = 10;
const DOC_LIMIT = 5;

/**
 * Dual-engine search.
 *   - faq: DB weighted LIKE + CJK bigram (top 10)
 *   - documents: ripgrep over per-agent parsed.md with frontmatter filter (top 5)
 *
 * Scores from the two sources intentionally remain in separate arrays (the
 * LIKE-weighted FAQ relevance and grep line-count relevance are not on the
 * same scale, so mixing them would silently bias ranking).
 */
export function fetchKnowledge(keyword?: string, agentId?: string): KnowledgeSearchResult {
  if (!keyword) {
    const db = getDb();
    const docFilter = 'WHERE k.document_id IS NULL';
    const faq = agentId
      ? db.prepare(
          `SELECT k.* FROM knowledge k WHERE k.id IN (SELECT knowledge_id FROM knowledge_agents WHERE agent_id = ?) AND k.document_id IS NULL ORDER BY k.created_at DESC`,
        ).all(agentId) as KnowledgeItem[]
      : db.prepare(`SELECT k.* FROM knowledge k ${docFilter} ORDER BY k.created_at DESC`).all() as KnowledgeItem[];
    return { faq, documents: [] };
  }

  const faq = searchFAQs(keyword, agentId).slice(0, FAQ_LIMIT);
  const documents = agentId ? grepSearchDocuments(keyword, agentId, DOC_LIMIT) : [];
  return { faq, documents };
}

export function fetchKnowledgeByUpdatedTime(since?: string, until?: string, agentId?: string, limit = 20): KnowledgeItem[] {
  const db = getDb();
  const conditions: string[] = ['k.document_id IS NULL'];
  const params: string[] = [];

  if (since) {
    conditions.push('k.updated_at >= ?');
    params.push(since);
  }
  if (until) {
    conditions.push('k.updated_at <= ?');
    params.push(until);
  }

  if (agentId) {
    conditions.push('k.id IN (SELECT knowledge_id FROM knowledge_agents WHERE agent_id = ?)');
    params.push(agentId);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const cap = Math.min(Math.max(limit, 1), 50);
  const sql = `SELECT k.* FROM knowledge k ${where} ORDER BY k.updated_at DESC LIMIT ?`;
  params.push(String(cap));

  return db.prepare(sql).all(...params) as KnowledgeItem[];
}

export function search(args: string): void {
  const keyword = args.trim();
  const { faq, documents } = fetchKnowledge(keyword || undefined, getCurrentAgent()?.id);

  if (faq.length === 0 && documents.length === 0) {
    log.print('未找到相关结果');
    return;
  }

  const db = getDb();

  if (faq.length > 0) {
    log.print(`【FAQ】共 ${faq.length} 条`);
    for (const item of faq) {
      const agents = (db.prepare(
        `SELECT a.name FROM agents a INNER JOIN knowledge_agents ka ON ka.agent_id = a.id WHERE ka.knowledge_id = ?`
      ).all(item.id) as { name: string }[]).map(a => a.name);

      log.print(`  [${item.id.slice(0, 8)}] Q: ${item.question}`);
      log.print(`           A: ${item.answer}`);
      if (item.tags) log.print(`           标签: ${item.tags}`);
      if (item.related_users) log.print(`           相关人员: ${item.related_users}`);
      log.print(`           所属Agent: ${agents.length > 0 ? agents.join(', ') : '(全局)'}`);
      log.print(`           创建: ${item.created_at} | 修改: ${item.updated_at}`);
      log.print();
    }
  }

  if (documents.length > 0) {
    log.print(`【文档】共 ${documents.length} 条`);
    for (const doc of documents) {
      log.print(`  [${doc.document_id.slice(0, 8)}] ${doc.title}`);
      log.print(`           ${doc.snippet}`);
      if (doc.tags) log.print(`           标签: ${doc.tags}`);
      log.print();
    }
  }
}

export async function add(args?: string, agentId?: string): Promise<void> {
  let question: string, answer: string, tags: string, relatedUsers: string;

  if (args?.trim()) {
    const parts = args.split('|').map(s => s.trim());
    if (parts.length < 2) {
      log.print('用法: /faq-add 问题 | 回答 | 标签(可选) | 相关人员(可选)');
      return;
    }
    [question, answer, tags, relatedUsers] = [parts[0], parts[1], parts[2] ?? '', parts[3] ?? ''];
  } else if (isInteractive()) {
    question = await remoteInput('问题：');
    answer = await remoteInput('回答：');
    tags = await remoteInput('标签（可选，逗号分隔）：');
    relatedUsers = await remoteInput('相关人员（可选，逗号分隔）：');
  } else {
    log.print('用法: /faq-add 问题 | 回答 | 标签(可选) | 相关人员(可选)');
    return;
  }

  if (!question?.trim() || !answer?.trim()) {
    log.print('问题和回答不能为空');
    return;
  }

  const result = addKnowledge(
    { question: question.trim(), answer: answer.trim(), tags: tags || undefined, related_users: relatedUsers || undefined },
    agentId,
  );
  if (result.success) {
    log.print(`FAQ已添加: ${result.id}`);
  } else {
    log.print(result.error!);
  }
}

export function remove(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.print('用法: faq-del <id>');
    return;
  }

  const db = getDb();
  const rows = db.prepare('SELECT * FROM knowledge WHERE id LIKE ?').all(`${idPrefix}%`) as KnowledgeItem[];

  if (rows.length === 0) {
    log.print(`未找到FAQ: ${idPrefix}`);
    return;
  }
  if (rows.length > 1) {
    log.print('匹配到多条，请提供更长的ID前缀');
    return;
  }

  const perm = ensureKnowledgeWriteAccess(getCurrentAgent()?.id, rows[0].id);
  if (!perm.success) {
    log.print(perm.error);
    return;
  }

  db.prepare('DELETE FROM knowledge WHERE id = ?').run(rows[0].id);
  recordEvent('knowledge', rows[0].id, 'delete', { question: rows[0].question });
  log.print(`FAQ已删除: ${rows[0].question}`);
}

/** LLM 工具调用：按 ID 前缀删除知识库条目 */
export function deleteKnowledge(idPrefix: string, agentId?: string): { success: boolean; question?: string; error?: string } {
  if (!idPrefix) return { success: false, error: '需要提供 FAQ ID 或 ID 前缀' };

  const db = getDb();
  const rows = db.prepare('SELECT * FROM knowledge WHERE id LIKE ?').all(`${idPrefix}%`) as KnowledgeItem[];

  if (rows.length === 0) return { success: false, error: `未找到FAQ: ${idPrefix}` };
  if (rows.length > 1) return { success: false, error: '匹配到多条，请提供更长的ID前缀' };

  const item = rows[0];
  const perm = ensureKnowledgeWriteAccess(agentId, item.id);
  if (!perm.success) return perm;
  // 同时清理 knowledge_agents 关联
  db.prepare('DELETE FROM knowledge_agents WHERE knowledge_id = ?').run(item.id);
  db.prepare('DELETE FROM knowledge WHERE id = ?').run(item.id);
  recordEvent('knowledge', item.id, 'delete', { question: item.question });
  return { success: true, question: item.question };
}

/** LLM 工具调用：新增知识库条目（无需交互式输入） */
export function addKnowledge(fields: { question: string; answer: string; tags?: string; related_users?: string }, agentId?: string): { success: boolean; id?: string; error?: string } {
  if (!fields.question?.trim()) return { success: false, error: '问题不能为空' };
  if (!fields.answer?.trim()) return { success: false, error: '答案不能为空' };
  const perm = ensureKnowledgeWriteAccess(agentId);
  if (!perm.success) return perm;

  const db = getDb();
  const user = getCurrentUser();
  const id = uuid();

  db.prepare(
    'INSERT INTO knowledge (id, question, answer, tags, related_users, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, fields.question.trim(), fields.answer.trim(), fields.tags || null, fields.related_users || null, user.id);

  if (agentId) {
    try {
      db.prepare(
        'INSERT OR IGNORE INTO knowledge_agents (id, knowledge_id, agent_id) VALUES (?, ?, ?)'
      ).run(uuid(), id, agentId);
    } catch (_) { /* ignore */ }
  }

  recordEvent('knowledge', id, 'create', { question: fields.question });
  return { success: true, id: id.slice(0, 8) };
}

/** LLM 工具调用：按 ID 前缀更新知识库 QA（无需交互式输入） */
export function updateKnowledgeById(idPrefix: string, fields: { question?: string; answer?: string; tags?: string; related_users?: string }, agentId?: string): { success: boolean; id?: string; error?: string } {
  if (!idPrefix) return { success: false, error: '需要提供 FAQ ID 或 ID 前缀' };

  const db = getDb();
  const rows = db.prepare('SELECT * FROM knowledge WHERE id LIKE ?').all(`${idPrefix}%`) as KnowledgeItem[];

  if (rows.length === 0) return { success: false, error: `未找到FAQ: ${idPrefix}` };
  if (rows.length > 1) return { success: false, error: '匹配到多条，请提供更长的ID前缀' };

  const item = rows[0];
  const perm = ensureKnowledgeWriteAccess(agentId, item.id);
  if (!perm.success) return perm;
  const question = fields.question ?? item.question;
  const answer = fields.answer ?? item.answer;
  const tags = fields.tags !== undefined ? (fields.tags || null) : item.tags;
  const relatedUsers = fields.related_users !== undefined ? (fields.related_users || null) : item.related_users;

  const user = getCurrentUser();
  db.prepare(
    'UPDATE knowledge SET question = ?, answer = ?, tags = ?, related_users = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(question, answer, tags, relatedUsers, item.id);

  recordEvent('knowledge', item.id, 'update', { question, modified_by: user.id });
  return { success: true, id: item.id };
}

export async function update(args: string): Promise<void> {
  if (!args?.trim()) {
    log.print('用法: /faq-update <id> [问题 | 回答 | 标签 | 相关人员]');
    return;
  }

  const pipeIdx = args.indexOf('|');
  let idPrefix: string;
  let inlineFields: string | undefined;

  if (pipeIdx >= 0) {
    const beforePipe = args.slice(0, pipeIdx).trim();
    const tokens = beforePipe.split(/\s+/);
    idPrefix = tokens[0];
    const rest = tokens.slice(1).join(' ').trim();
    inlineFields = rest ? rest + ' |' + args.slice(pipeIdx + 1) : args.slice(pipeIdx + 1);
  } else {
    const tokens = args.trim().split(/\s+/);
    idPrefix = tokens[0];
    const rest = tokens.slice(1).join(' ').trim();
    if (rest) inlineFields = rest;
  }

  const db = getDb();
  const rows = db.prepare('SELECT * FROM knowledge WHERE id LIKE ?').all(`${idPrefix}%`) as KnowledgeItem[];

  if (rows.length === 0) {
    log.print(`未找到FAQ: ${idPrefix}`);
    return;
  }
  if (rows.length > 1) {
    log.print('匹配到多条，请提供更长的ID前缀');
    return;
  }

  const item = rows[0];
  let question: string, answer: string, tags: string, relatedUsers: string;

  if (inlineFields) {
    const parts = inlineFields.split('|').map(s => s.trim());
    question = parts[0] || item.question;
    answer = parts[1] ?? item.answer;
    tags = parts[2] ?? (item.tags || '');
    relatedUsers = parts[3] ?? (item.related_users || '');
  } else if (isInteractive()) {
    const perm = ensureKnowledgeWriteAccess(getCurrentAgent()?.id, item.id);
    if (!perm.success) {
      log.print(perm.error);
      return;
    }
    question = await remoteInput(`问题 [${item.question}]：`, item.question);
    answer = await remoteInput(`回答 [${item.answer}]：`, item.answer);
    tags = await remoteInput(`标签 [${item.tags || ''}]：`, item.tags || '');
    relatedUsers = await remoteInput(`相关人员 [${item.related_users || ''}]：`, item.related_users || '');
  } else {
    log.print('用法: /faq-update <id> 问题 | 回答 | 标签(可选) | 相关人员(可选)');
    return;
  }

  const result = updateKnowledgeById(
    idPrefix,
    { question, answer, tags, related_users: relatedUsers },
    getCurrentAgent()?.id,
  );
  if (result.success) {
    log.print(`FAQ已更新: ${item.id.slice(0, 8)}`);
  } else {
    log.print(result.error!);
  }
}

/** 关联知识条目到 agent */
export function assignKnowledgeToAgent(knowledgeIdPrefix: string, agentId: string): { success: boolean; error?: string } {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM knowledge WHERE id LIKE ?').all(`${knowledgeIdPrefix}%`) as { id: string }[];
  if (rows.length === 0) return { success: false, error: `未找到知识条目: ${knowledgeIdPrefix}` };
  if (rows.length > 1) return { success: false, error: '匹配到多条，请提供更长的ID前缀' };

  const agentRow = db.prepare('SELECT id FROM agents WHERE id = ? OR name = ?').get(agentId, agentId) as { id: string } | undefined;
  if (!agentRow) return { success: false, error: `未找到 Agent: ${agentId}` };

  try {
    db.prepare('INSERT OR IGNORE INTO knowledge_agents (id, knowledge_id, agent_id) VALUES (?, ?, ?)').run(uuid(), rows[0].id, agentRow.id);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/** 解除知识条目与 agent 的关联 */
export function unassignKnowledgeFromAgent(knowledgeIdPrefix: string, agentId: string): { success: boolean; error?: string } {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM knowledge WHERE id LIKE ?').all(`${knowledgeIdPrefix}%`) as { id: string }[];
  if (rows.length === 0) return { success: false, error: `未找到知识条目: ${knowledgeIdPrefix}` };
  if (rows.length > 1) return { success: false, error: '匹配到多条，请提供更长的ID前缀' };

  const agentRow = db.prepare('SELECT id FROM agents WHERE id = ? OR name = ?').get(agentId, agentId) as { id: string } | undefined;
  if (!agentRow) return { success: false, error: `未找到 Agent: ${agentId}` };

  const result = db.prepare('DELETE FROM knowledge_agents WHERE knowledge_id = ? AND agent_id = ?').run(rows[0].id, agentRow.id);
  if (result.changes === 0) return { success: false, error: '该关联不存在' };
  return { success: true };
}

/** 查询知识条目关联的 agent 列表 */
export function getKnowledgeAgents(knowledgeIdPrefix: string): { success: boolean; agents?: string[]; error?: string } {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM knowledge WHERE id LIKE ?').all(`${knowledgeIdPrefix}%`) as { id: string }[];
  if (rows.length === 0) return { success: false, error: `未找到知识条目: ${knowledgeIdPrefix}` };
  if (rows.length > 1) return { success: false, error: '匹配到多条，请提供更长的ID前缀' };

  const agents = db.prepare(
    `SELECT a.name FROM agents a INNER JOIN knowledge_agents ka ON ka.agent_id = a.id WHERE ka.knowledge_id = ?`
  ).all(rows[0].id) as { name: string }[];
  return { success: true, agents: agents.map(a => a.name) };
}
