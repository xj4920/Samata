/**
 * 一次性迁移脚本：将 knowledge 表中的 approved-* ID 替换为标准 UUID
 *
 * 背景：
 * - 旧版 review-qa.ts 使用 item.id.replace('pending-', 'approved-') 生成 ID
 * - 新版使用 uuid() 生成标准 UUID（与 faq-add 一致）
 * - 本脚本将已有的 approved-* ID 替换为 UUID
 *
 * Usage: npx tsx scripts/migrate-approved-ids.ts
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

const DB_PATH = './data/yanyu.db';

interface KnowledgeRow {
  id: string;
  question: string;
  answer: string;
  tags: string | null;
  related_users: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function migrateApprovedIds() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 1. 查找所有 approved-* ID
  const rows = db.prepare(`
    SELECT * FROM knowledge WHERE id LIKE 'approved-%'
  `).all() as KnowledgeRow[];

  if (rows.length === 0) {
    console.log('没有需要迁移的 approved-* ID');
    db.close();
    return;
  }

  console.log(`找到 ${rows.length} 条需要迁移的记录\n`);

  // 2. 创建临时表
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_migration_temp (
      old_id TEXT PRIMARY KEY,
      new_id TEXT NOT NULL UNIQUE
    )
  `);

  // 3. 生成 ID 映射
  const idMap = new Map<string, string>();
  for (const row of rows) {
    const newId = uuid();
    idMap.set(row.id, newId);
    db.prepare(`
      INSERT INTO knowledge_migration_temp (old_id, new_id) VALUES (?, ?)
    `).run(row.id, newId);
  }

  console.log('ID 映射已生成，开始迁移...\n');

  // 4. 在事务中执行迁移
  const tx = db.transaction(() => {
    for (const row of rows) {
      const newId = idMap.get(row.id)!;

      // 插入新记录
      db.prepare(`
        INSERT INTO knowledge
        (id, question, answer, tags, related_users, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId,
        row.question,
        row.answer,
        row.tags,
        row.related_users,
        row.created_by,
        row.created_at,
        row.updated_at
      );

      // 删除旧记录
      db.prepare(`DELETE FROM knowledge WHERE id = ?`).run(row.id);

      console.log(`  ${row.id.slice(0, 40)}... → ${newId.slice(0, 8)}`);
    }
  });

  tx();

  console.log(`\n迁移完成！共处理 ${rows.length} 条记录`);
  console.log('ID 映射已保存在 knowledge_migration_temp 表中（可用于回滚）');

  db.close();
}

// 运行迁移
migrateApprovedIds();
