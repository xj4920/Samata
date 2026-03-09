/**
 * 清理指定 topic 的所有提取数据，以便从头重新提取
 *
 * Usage: npx tsx scripts/clean-topic.ts <topic-name>
 */
import Database from 'better-sqlite3';

const DB_PATH = './data/yanyu.db';
const topicName = process.argv[2];

if (!topicName) {
  console.error('用法: npx tsx scripts/clean-topic.ts <topic-name>');
  console.error('示例: npx tsx scripts/clean-topic.ts FIX协议对接');
  process.exit(1);
}

const db = new Database(DB_PATH);

// 清理前统计
const before = db.prepare(`
  SELECT COUNT(*) as cnt FROM knowledge_pending WHERE topic_name = ?
`).get(topicName) as any;

const msgBefore = db.prepare(`
  SELECT COUNT(*) as cnt FROM message_processing_log WHERE processed_topics LIKE '%' || ? || '%'
`).get(topicName) as any;

console.log(`\n清理主题: ${topicName}`);
console.log(`  pending QA: ${before.cnt} 条`);
console.log(`  消息处理记录: ${msgBefore.cnt} 条`);

if (before.cnt === 0 && msgBefore.cnt === 0) {
  console.log('\n没有数据需要清理');
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  // 1. 删除审核日志
  const logResult = db.prepare(`
    DELETE FROM knowledge_review_log WHERE pending_id IN (
      SELECT id FROM knowledge_pending WHERE topic_name = ?
    )
  `).run(topicName);

  // 2. 删除待审核 QA
  const pendingResult = db.prepare(`
    DELETE FROM knowledge_pending WHERE topic_name = ?
  `).run(topicName);

  // 3. 清除消息处理记录中该 topic 的标记
  db.prepare(`
    UPDATE message_processing_log
    SET processed_topics = REPLACE(processed_topics, ?,''),
        extraction_count = MAX(extraction_count - 1, 0)
    WHERE processed_topics LIKE '%' || ? || '%'
  `).run(topicName, topicName);

  // 清理 processed_topics 中可能残留的逗号
  db.prepare(`
    UPDATE message_processing_log
    SET processed_topics = REPLACE(REPLACE(REPLACE(processed_topics, ',,', ','), ',', ''), ',', '')
    WHERE processed_topics LIKE '%,%'
  `).run();

  // 4. 删除 topic 元数据
  db.prepare(`
    DELETE FROM topic_extraction_metadata WHERE topic_name = ?
  `).run(topicName);

  console.log(`\n已清理:`);
  console.log(`  审核日志: ${logResult.changes} 条`);
  console.log(`  pending QA: ${pendingResult.changes} 条`);
  console.log(`  消息处理标记: 已清除`);
  console.log(`  topic 元数据: 已删除`);
});

tx();
db.close();

console.log(`\n✓ 主题 [${topicName}] 数据已清理，可重新提取\n`);
