import { getDb } from '../db/connection.js';
import { getCurrentUser } from '../auth/rbac.js';
import { recordEvent } from '../models/event.js';
import { log } from '../utils/logger.js';
import { input, confirm } from '@inquirer/prompts';
import { v4 as uuid } from 'uuid';
import { findSimilarQuestions } from '../utils/qa-dedup.js';

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

export function fetchKnowledge(keyword?: string): KnowledgeItem[] {
  const db = getDb();
  if (keyword) {
    return db.prepare(
      'SELECT * FROM knowledge WHERE question LIKE ? OR answer LIKE ? OR tags LIKE ? ORDER BY created_at DESC'
    ).all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`) as KnowledgeItem[];
  }
  return db.prepare('SELECT * FROM knowledge ORDER BY created_at DESC').all() as KnowledgeItem[];
}

export function search(args: string): void {
  const db = getDb();
  const keyword = args.trim();

  let rows: KnowledgeItem[];
  if (keyword) {
    rows = db.prepare(
      'SELECT * FROM knowledge WHERE question LIKE ? OR answer LIKE ? OR tags LIKE ? ORDER BY created_at DESC'
    ).all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`) as KnowledgeItem[];
  } else {
    rows = db.prepare('SELECT * FROM knowledge ORDER BY created_at DESC').all() as KnowledgeItem[];
  }

  if (rows.length === 0) {
    log.print('未找到相关FAQ');
    return;
  }

  for (const item of rows) {
    log.print(`  [${item.id.slice(0, 8)}] Q: ${item.question}`);
    log.print(`           A: ${item.answer}`);
    if (item.tags) log.print(`           标签: ${item.tags}`);
    if (item.related_users) log.print(`           相关人员: ${item.related_users}`);
    log.print(`           创建: ${item.created_at} | 修改: ${item.updated_at}`);
    log.print();
  }
  log.print(`共 ${rows.length} 条`);
}

export async function add(): Promise<void> {
  const question = await input({ message: '问题：' });
  const answer = await input({ message: '回答：' });
  const tags = await input({ message: '标签（可选，逗号分隔）：' });
  const relatedUsers = await input({ message: '相关人员（可选，逗号分隔）：' });

  const db = getDb();

  // 语义去重检查
  const dedupResult = await findSimilarQuestions(db, question);
  if (dedupResult.hasDuplicate) {
    const top = dedupResult.candidates.find(c => c.semanticMatch) || dedupResult.candidates[0];
    log.print(`\n⚠ 知识库中已存在相似问题：`);
    log.print(`  已有: ${top.question}`);
    log.print(`  相似度: ${(top.similarity * 100).toFixed(0)}%`);
    if (top.answer) {
      const preview = top.answer.length > 80 ? top.answer.substring(0, 80) + '...' : top.answer;
      log.print(`  已有答案: ${preview}`);
    }
    const proceed = await confirm({ message: '仍然添加？', default: false });
    if (!proceed) {
      log.print('已取消');
      return;
    }
  }

  const user = getCurrentUser();
  const id = uuid();

  db.prepare(
    'INSERT INTO knowledge (id, question, answer, tags, related_users, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, question, answer, tags || null, relatedUsers || null, user.id);

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

  db.prepare('DELETE FROM knowledge WHERE id = ?').run(rows[0].id);
  recordEvent('knowledge', rows[0].id, 'delete', { question: rows[0].question });
  log.print(`FAQ已删除: ${rows[0].question}`);
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
