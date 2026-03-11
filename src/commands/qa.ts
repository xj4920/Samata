/**
 * /qa — QA 提取管线 CLI 入口
 * 直接调用 src/commands/ 下的模块函数
 */
import Database from 'better-sqlite3';
import { log } from '../utils/logger.js';
import { incrementalExtract } from './qa-extraction.js';
import { mergeQA } from './qa-merge.js';
import { reviewQA } from './qa-review.js';
import { scoreTopicQA } from './qa-scoring.js';
import { TOPICS } from '../config/topics.js';

const DB_PATH = './data/yanyu.db';

interface Subcommand {
  handler: (parts: string[]) => Promise<void>;
  requiresTopic: boolean;
  description: string;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  extract:  { handler: handleExtract,  requiresTopic: false, description: '增量提取 Q&A' },
  merge:    { handler: handleMerge,    requiresTopic: false, description: '合并相似 Q&A（交互式）' },
  review:   { handler: handleReview,   requiresTopic: false, description: '审核 Q&A（交互式）' },
  score:    { handler: handleScore,    requiresTopic: true,  description: '评估 Q&A 质量' },
  validate: { handler: handleValidate, requiresTopic: false, description: '验证提取完整性' },
  clean:    { handler: handleClean,    requiresTopic: true,  description: '清理指定主题的提取数据' },
};

export async function handleQA(args: string): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[0]?.toLowerCase();

  if (!subcommand || subcommand === 'help') {
    showHelp();
    return;
  }

  const subcmd = SUBCOMMANDS[subcommand];
  if (!subcmd) {
    log.print(`未知子命令: ${subcommand}`);
    showHelp();
    return;
  }

  const topic = parts[1];
  if (subcmd.requiresTopic && !topic) {
    log.print(`用法: /qa ${subcommand} <topic-name>`);
    return;
  }

  try {
    await subcmd.handler(parts.slice(1));
  } catch (err: any) {
    log.print(`执行失败: ${err.message}`);
  }
}

// ============ 子命令处理 ============

async function handleExtract(args: string[]) {
  const topicName = args[0];
  const limit = args[1] ? parseInt(args[1], 10) : undefined;
  await incrementalExtract(topicName, limit);
}

async function handleMerge(args: string[]) {
  await mergeQA(args[0]);
}

async function handleReview(args: string[]) {
  await reviewQA(args[0]);
}

async function handleScore(args: string[]) {
  await scoreTopicQA(args[0]);
}

async function handleValidate(args: string[]) {
  validateExtractionCoverage(args[0]);
}

async function handleClean(args: string[]) {
  cleanTopic(args[0]);
}

// ============ validate 逻辑 ============

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

    const extractionRate =
      metadata.total_messages_scanned > 0
        ? ((metadata.total_qa_extracted / metadata.total_messages_scanned) * 100).toFixed(2)
        : 0;

    console.log(`  提取率: ${extractionRate}% (Q&A数 / 消息数)`);

    if (parseFloat(extractionRate as string) < 1) {
      console.log(`  ⚠️  提取率偏低，可能需要优化 prompt 或关键词`);
    }

    const pendingCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM knowledge_pending WHERE topic_name = ? AND review_status = 'pending'`
      )
      .get(topic.name) as { count: number };

    console.log(`  待审核: ${pendingCount.count} 个`);

    const approvedCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM knowledge_pending WHERE topic_name = ? AND review_status = 'approved'`
      )
      .get(topic.name) as { count: number };

    console.log(`  已批准: ${approvedCount.count} 个`);

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

function findTimeGaps(
  db: Database.Database,
  topicName: string
): Array<{ start: string; end: string; duration: number }> {
  const messages = db
    .prepare(`
    SELECT message_time
    FROM message_processing_log
    WHERE processed_topics LIKE ?
    ORDER BY message_time
  `)
    .all(`%${topicName}%`) as Array<{ message_time: string }>;

  const gaps: Array<{ start: string; end: string; duration: number }> = [];

  for (let i = 1; i < messages.length; i++) {
    const prev = new Date(messages[i - 1].message_time);
    const curr = new Date(messages[i].message_time);
    const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);

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

// ============ clean 逻辑 ============

function cleanTopic(topicName: string) {
  const db = new Database(DB_PATH);

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
    return;
  }

  const tx = db.transaction(() => {
    const logResult = db.prepare(`
      DELETE FROM knowledge_review_log WHERE pending_id IN (
        SELECT id FROM knowledge_pending WHERE topic_name = ?
      )
    `).run(topicName);

    const pendingResult = db.prepare(`
      DELETE FROM knowledge_pending WHERE topic_name = ?
    `).run(topicName);

    db.prepare(`
      UPDATE message_processing_log
      SET processed_topics = REPLACE(processed_topics, ?,''),
          extraction_count = MAX(extraction_count - 1, 0)
      WHERE processed_topics LIKE '%' || ? || '%'
    `).run(topicName, topicName);

    db.prepare(`
      UPDATE message_processing_log
      SET processed_topics = REPLACE(REPLACE(REPLACE(processed_topics, ',,', ','), ',', ''), ',', '')
      WHERE processed_topics LIKE '%,%'
    `).run();

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
}

// ============ 帮助 ============

function showHelp(): void {
  log.print('Q&A 提取管线:');
  log.print('  用法: /qa <子命令> [topic] [options]\n');
  log.print('子命令:');
  for (const [name, info] of Object.entries(SUBCOMMANDS)) {
    const hint = info.requiresTopic ? ' <topic>' : ' [topic]';
    log.print(`  ${name.padEnd(10)} ${info.description}${hint}`);
  }
  log.print('\n示例:');
  log.print('  /qa extract FIX协议对接');
  log.print('  /qa merge FIX协议对接');
  log.print('  /qa review FIX协议对接');
  log.print('  /qa validate FIX协议对接');
  log.print('  /qa clean FIX协议对接');
}
