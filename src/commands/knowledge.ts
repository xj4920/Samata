import { getDb } from '../db/connection.js';
import { getCurrentUser } from '../auth/rbac.js';
import { recordEvent } from '../models/event.js';
import { log } from '../utils/logger.js';
import { input } from '@inquirer/prompts';
import { v4 as uuid } from 'uuid';

export interface KnowledgeItem {
  id: string;
  question: string;
  answer: string;
  tags: string | null;
  created_at: string;
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
    log.dim('未找到相关FAQ');
    return;
  }

  for (const item of rows) {
    console.log(`  [${item.id.slice(0, 8)}] Q: ${item.question}`);
    console.log(`           A: ${item.answer}`);
    if (item.tags) console.log(`           标签: ${item.tags}`);
    console.log();
  }
  log.dim(`共 ${rows.length} 条`);
}

export async function add(): Promise<void> {
  const question = await input({ message: '问题：' });
  const answer = await input({ message: '回答：' });
  const tags = await input({ message: '标签（可选，逗号分隔）：' });

  const db = getDb();
  const user = getCurrentUser();
  const id = uuid();

  db.prepare(
    'INSERT INTO knowledge (id, question, answer, tags, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(id, question, answer, tags || null, user.id);

  recordEvent('knowledge', id, 'create', { question });
  log.success(`FAQ已添加: ${id.slice(0, 8)}`);
}

export function remove(args: string): void {
  const idPrefix = args.trim();
  if (!idPrefix) {
    log.warn('用法: faq-del <id>');
    return;
  }

  const db = getDb();
  const rows = db.prepare('SELECT * FROM knowledge WHERE id LIKE ?').all(`${idPrefix}%`) as KnowledgeItem[];

  if (rows.length === 0) {
    log.error(`未找到FAQ: ${idPrefix}`);
    return;
  }
  if (rows.length > 1) {
    log.warn('匹配到多条，请提供更长的ID前缀');
    return;
  }

  db.prepare('DELETE FROM knowledge WHERE id = ?').run(rows[0].id);
  recordEvent('knowledge', rows[0].id, 'delete', { question: rows[0].question });
  log.success(`FAQ已删除: ${rows[0].question}`);
}
