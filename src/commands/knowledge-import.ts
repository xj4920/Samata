/**
 * 知识库导入模块
 * 从 Obsidian 知识库条目目录导入 QA 数据到 knowledge 表
 */
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';

const DB_PATH = './data/samata.db';

// Parse YAML frontmatter from markdown file content
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    return parseYaml(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Check if a string value is considered "non-empty"
function isNonEmpty(val: unknown): val is string {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  return trimmed !== '' && trimmed !== '-' && trimmed !== '"-"';
}

// Format tags array or string to comma-separated string
function formatList(val: unknown): string | null {
  if (Array.isArray(val)) {
    const filtered = val.filter((v) => typeof v === 'string' && v.trim() !== '' && v.trim() !== '-');
    return filtered.length > 0 ? filtered.join(',') : null;
  }
  if (typeof val === 'string' && val.trim()) return val;
  return null;
}

export function importKnowledge(kbDir: string) {
  // Read all .md files
  const files = fs.readdirSync(kbDir).filter((f) => f.endsWith('.md'));
  console.log(`找到 ${files.length} 个 .md 文件`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const insert = db.prepare(
    'INSERT INTO knowledge (id, question, answer, tags, related_users, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  // Check existing questions to avoid duplicates
  const existingQuestions = new Set(
    (db.prepare('SELECT question FROM knowledge').all() as { question: string }[]).map((r) => r.question)
  );

  let imported = 0;
  let skippedEmpty = 0;
  let skippedDup = 0;
  let skippedParseFail = 0;

  for (const file of files) {
    const filePath = path.join(kbDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);

    if (!fm) {
      skippedParseFail++;
      console.log(`  [跳过] 无法解析 frontmatter: ${file}`);
      continue;
    }

    const question = fm['问题'];
    const answer = fm['方案'];

    if (!isNonEmpty(question) || !isNonEmpty(answer)) {
      skippedEmpty++;
      continue;
    }

    // Append markdown body if exists (content after frontmatter)
    let fullAnswer = (answer as string).trim();
    const bodyMatch = content.match(/^---[\s\S]*?---\r?\n([\s\S]+)/);
    if (bodyMatch) {
      const body = bodyMatch[1].trim();
      if (body) {
        fullAnswer = fullAnswer + '\n\n' + body;
      }
    }

    if (existingQuestions.has(question as string)) {
      skippedDup++;
      console.log(`  [跳过] 已存在: ${(question as string).slice(0, 40)}`);
      continue;
    }

    const tags = formatList(fm['标签']);
    const relatedUsers = formatList(fm['相关人']);
    const createdAt = fm['创建日期']
      ? `${fm['创建日期']}T00:00:00`
      : new Date().toISOString().replace('T', ' ').slice(0, 19);
    const updatedAt = fm['上次编辑时间']
      ? new Date(fm['上次编辑时间'] as string).toISOString().replace('T', ' ').slice(0, 19)
      : createdAt;

    const id = uuid();
    insert.run(id, question, fullAnswer, tags, relatedUsers, 'admin-001', createdAt, updatedAt);
    imported++;
    console.log(`  [导入] ${(question as string).slice(0, 50)}`);
    existingQuestions.add(question as string);
  }

  db.close();

  console.log('\n--- 导入完成 ---');
  console.log(`  导入: ${imported}`);
  console.log(`  跳过(问题/方案为空): ${skippedEmpty}`);
  console.log(`  跳过(已存在): ${skippedDup}`);
  console.log(`  跳过(解析失败): ${skippedParseFail}`);
}
