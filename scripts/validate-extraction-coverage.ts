/**
 * 完整性验证工具
 * 检查每个主题的提取完整性
 *
 * Usage: npx tsx scripts/validate-extraction-coverage.ts
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { TOPICS } from './topics-config.js';

const DB_PATH = './data/yanyu.db';

/**
 * 验证提取完整性
 */
function validateExtractionCoverage(topicFilter?: string) {
  const db = new Database(DB_PATH);

  console.log('\n提取完整性报告');
  console.log('='.repeat(80) + '\n');

  const topics = topicFilter
    ? TOPICS.filter(t => t.name === topicFilter)
    : TOPICS;

  if (topicFilter && topics.length === 0) {
    console.log(`未找到主题: ${topicFilter}\n`);
    db.close();
    return;
  }

  for (const topic of topics) {
    console.log(`主题: ${topic.name}`);
    console.log('-'.repeat(80));

    // 1. 获取主题元数据
    const metadata = db
      .prepare(`SELECT * FROM topic_extraction_metadata WHERE topic_name = ?`)
      .get(topic.name) as any;

    if (!metadata) {
      console.log('  ❌ 未开始提取\n');
      continue;
    }

    console.log(`  状态: ${metadata.status}`);
    console.log(`  最后提取: ${metadata.last_extraction_time}`);
    console.log(`  扫描消息: ${metadata.total_messages_scanned} 条`);
    console.log(`  提取 Q&A: ${metadata.total_qa_extracted} 个`);
    console.log(
      `  时间范围: ${metadata.date_range_start} ~ ${metadata.date_range_end}`
    );

    // 2. 检查提取率
    const extractionRate =
      metadata.total_messages_scanned > 0
        ? ((metadata.total_qa_extracted / metadata.total_messages_scanned) * 100).toFixed(2)
        : 0;

    console.log(`  提取率: ${extractionRate}% (Q&A数 / 消息数)`);

    if (parseFloat(extractionRate as string) < 1) {
      console.log(`  ⚠️  提取率偏低，可能需要优化 prompt 或关键词`);
    }

    // 3. 检查待审核数量
    const pendingCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM knowledge_pending WHERE topic_name = ? AND review_status = 'pending'`
      )
      .get(topic.name) as { count: number };

    console.log(`  待审核: ${pendingCount.count} 个`);

    // 4. 检查已批准数量
    const approvedCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM knowledge_pending WHERE topic_name = ? AND review_status = 'approved'`
      )
      .get(topic.name) as { count: number };

    console.log(`  已批准: ${approvedCount.count} 个`);

    // 5. 检查时间覆盖缺口
    const gaps = findTimeGaps(db, topic.name);
    if (gaps.length > 0) {
      console.log(`  ⚠️  发现 ${gaps.length} 个时间缺口:`);
      gaps.forEach(gap => {
        console.log(`     ${gap.start} ~ ${gap.end} (${gap.duration} 天)`);
      });
    } else {
      console.log(`  ✓ 时间覆盖连续`);
    }

    console.log();
  }

  db.close();

  console.log('='.repeat(80));
  console.log('验证完成\n');
}

/**
 * 查找时间覆盖缺口
 */
function findTimeGaps(
  db: Database.Database,
  topicName: string
): Array<{ start: string; end: string; duration: number }> {
  const messages = db
    .prepare(
      `
    SELECT message_time
    FROM message_processing_log
    WHERE processed_topics LIKE ?
    ORDER BY message_time
  `
    )
    .all(`%${topicName}%`) as Array<{ message_time: string }>;

  const gaps: Array<{ start: string; end: string; duration: number }> = [];

  for (let i = 1; i < messages.length; i++) {
    const prev = new Date(messages[i - 1].message_time);
    const curr = new Date(messages[i].message_time);
    const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);

    // 如果间隔超过 30 天，视为缺口
    if (diffDays > 30) {
      gaps.push({
        start: messages[i - 1].message_time,
        end: messages[i].message_time,
        duration: Math.floor(diffDays),
      });
    }
  }

  return gaps;
}

const topicFilter = process.argv[2];
validateExtractionCoverage(topicFilter);
