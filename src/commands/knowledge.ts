import { getDb } from '../db/connection.js';
import { getCurrentUser, isAgentAdmin, isSystemAdmin } from '../auth/rbac.js';
import { getCurrentAgent } from '../llm/agent.js';
import { recordEvent } from '../models/event.js';
import { log } from '../utils/logger.js';
import { input } from '@inquirer/prompts';
import { v4 as uuid } from 'uuid';

export interface KnowledgeItem {
  id: string;
  question: string;
  answer: string;
  tags: string | null;
  related_users: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

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

export function fetchKnowledge(keyword?: string, agentId?: string): KnowledgeItem[] {
  const db = getDb();
  const agentFilter = agentId
    ? 'AND k.id IN (SELECT knowledge_id FROM knowledge_agents WHERE agent_id = ?)'
    : '';

  if (!keyword) {
    if (agentId) {
      return db.prepare(
        `SELECT k.* FROM knowledge k WHERE k.id IN (SELECT knowledge_id FROM knowledge_agents WHERE agent_id = ?) ORDER BY k.created_at DESC`
      ).all(agentId) as KnowledgeItem[];
    }
    return db.prepare('SELECT * FROM knowledge ORDER BY created_at DESC').all() as KnowledgeItem[];
  }

  const keywords = keyword.split(/\s+/).filter(Boolean);
  if (keywords.length === 0) {
    if (agentId) {
      return db.prepare(
        `SELECT k.* FROM knowledge k WHERE k.id IN (SELECT knowledge_id FROM knowledge_agents WHERE agent_id = ?) ORDER BY k.created_at DESC`
      ).all(agentId) as KnowledgeItem[];
    }
    return db.prepare('SELECT * FROM knowledge ORDER BY created_at DESC').all() as KnowledgeItem[];
  }

  // 每个关键词匹配 question/answer/tags 任一字段即命中
  // 相关性评分：question 命中 +3，tags +2，answer +1
  const whereClauses = keywords.map(() =>
    '(k.question LIKE ? OR k.answer LIKE ? OR k.tags LIKE ?)'
  ).join(' OR ');

  const scoreExpr = keywords.map(() =>
    '(CASE WHEN k.question LIKE ? THEN 3 ELSE 0 END) + ' +
    '(CASE WHEN k.tags LIKE ? THEN 2 ELSE 0 END) + ' +
    '(CASE WHEN k.answer LIKE ? THEN 1 ELSE 0 END)'
  ).join(' + ');

  const sql = `SELECT k.*, (${scoreExpr}) as relevance FROM knowledge k WHERE (${whereClauses}) ${agentFilter} ORDER BY relevance DESC, k.created_at DESC`;

  const params: string[] = [];
  for (const kw of keywords) {
    params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`); // score params
  }
  for (const kw of keywords) {
    params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`); // where params
  }
  if (agentId) params.push(agentId);

  return db.prepare(sql).all(...params) as KnowledgeItem[];
}

export function search(args: string): void {
  const keyword = args.trim();
  const rows = fetchKnowledge(keyword || undefined, getCurrentAgent()?.id);

  if (rows.length === 0) {
    log.print('未找到相关FAQ');
    return;
  }

  const db = getDb();
  for (const item of rows) {
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
  log.print(`共 ${rows.length} 条`);
}

export async function add(args?: string, agentId?: string): Promise<void> {
  const question = await input({ message: '问题：' });
  const answer = await input({ message: '回答：' });
  const tags = await input({ message: '标签（可选，逗号分隔）：' });
  const relatedUsers = await input({ message: '相关人员（可选，逗号分隔）：' });

  const db = getDb();
  const user = getCurrentUser();
  const id = uuid();

  db.prepare(
    'INSERT INTO knowledge (id, question, answer, tags, related_users, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, question, answer, tags || null, relatedUsers || null, user.id);

  if (agentId) {
    try {
      db.prepare(
        'INSERT OR IGNORE INTO knowledge_agents (id, knowledge_id, agent_id) VALUES (?, ?, ?)'
      ).run(uuid(), id, agentId);
    } catch (e) {
      // ignore
    }
  }

  recordEvent('knowledge', id, 'create', { question });
  log.print(`FAQ已添加: ${id.slice(0, 8)}`);
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

export async function update(idPrefix: string): Promise<void> {
  if (!idPrefix) {
    log.print('用法: faq-update <id>');
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

  const item = rows[0];
  const perm = ensureKnowledgeWriteAccess(getCurrentAgent()?.id, item.id);
  if (!perm.success) {
    log.print(perm.error);
    return;
  }
  const question = await input({ message: `问题 [${item.question}]：`, default: item.question });
  const answer = await input({ message: `回答 [${item.answer}]：`, default: item.answer });
  const tags = await input({ message: `标签 [${item.tags || ''}]：`, default: item.tags || '' });
  const relatedUsers = await input({ message: `相关人员 [${item.related_users || ''}]：`, default: item.related_users || '' });

  const user = getCurrentUser();
  db.prepare(
    'UPDATE knowledge SET question = ?, answer = ?, tags = ?, related_users = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(question, answer, tags || null, relatedUsers || null, item.id);

  recordEvent('knowledge', item.id, 'update', { question, modified_by: user.id });
  log.print(`FAQ已更新: ${item.id.slice(0, 8)}`);
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
