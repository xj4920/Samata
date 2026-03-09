/**
 * 人工审核工具
 * 交互式 CLI，用于审核待审核表中的 Q&A
 *
 * Usage: npx tsx scripts/review-qa.ts [topic-name]
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import readline from 'readline';
import { v4 as uuid } from 'uuid';

const DB_PATH = './data/yanyu.db';

interface PendingQA {
  id: string;
  question: string;
  answer: string;
  tags: string;
  related_users: string;
  source_session: string;
  source_time: string;
  topic_name: string;
  auto_quality_score: number | null;
}

/**
 * 主函数：交互式审核
 */
async function reviewQA(topicName?: string) {
  const db = new Database(DB_PATH);

  // 显示审核统计
  showReviewStats(db);

  // 获取待审核的 Q&A
  const pendingItems = topicName
    ? getPendingByTopic(db, topicName)
    : getAllPending(db);

  if (pendingItems.length === 0) {
    console.log('\n✓ 没有待审核的 Q&A');
    db.close();
    return;
  }

  console.log(`\n找到 ${pendingItems.length} 个待审核 Q&A\n`);

  // 逐个审核
  let reviewed = 0;
  let approved = 0;
  let rejected = 0;
  let edited = 0;
  let skipped = 0;

  for (let i = 0; i < pendingItems.length; i++) {
    const item = pendingItems[i];

    console.log('\n' + '='.repeat(80));
    console.log(`Q&A #${i + 1}/${pendingItems.length}`);
    console.log('='.repeat(80));

    displayQA(item);

    const action = await askReviewAction();

    if (action === 'approve') {
      const ok = approveQA(db, item);
      approved++;
      reviewed++;
      if (ok) {
        console.log('✓ 已批准');
      }
    } else if (action === 'edit') {
      const newQuestion = await askEdit('编辑问题（留空保持不变）', item.question);
      const newAnswer = await askEdit('编辑答案（留空保持不变）', item.answer);
      editQA(db, item, newQuestion, newAnswer);
      edited++;
      reviewed++;
      console.log('✎ 已编辑并保存');
    } else if (action === 'reject') {
      const comment = await askComment('拒绝原因（可选）');
      rejectQA(db, item, comment);
      rejected++;
      reviewed++;
      console.log('✗ 已拒绝');
    } else if (action === 'skip') {
      skipped++;
      console.log('⊙ 已跳过');
    } else if (action === 'quit') {
      console.log('\n审核已中断');
      break;
    }

    // 每审核 10 个，显示进度
    if ((reviewed + skipped) % 10 === 0 && (reviewed + skipped) > 0) {
      console.log(`\n--- 进度: ${reviewed + skipped}/${pendingItems.length} ---`);
      console.log(`批准: ${approved}, 编辑: ${edited}, 拒绝: ${rejected}, 跳过: ${skipped}\n`);
    }
  }

  db.close();

  // 最终统计
  console.log('\n' + '='.repeat(80));
  console.log('审核完成');
  console.log('='.repeat(80));
  console.log(`总计: ${reviewed + skipped}`);
  console.log(`批准: ${approved}`);
  console.log(`编辑: ${edited}`);
  console.log(`拒绝: ${rejected}`);
  console.log(`跳过: ${skipped}`);
  console.log('='.repeat(80) + '\n');
}

/**
 * 显示审核统计
 */
function showReviewStats(db: Database.Database) {
  const stats = db.prepare('SELECT * FROM review_stats').all() as any[];

  console.log('\n审核统计');
  console.log('='.repeat(80));
  console.log(
    '主题'.padEnd(30) +
      '待审核'.padEnd(10) +
      '已批准'.padEnd(10) +
      '已拒绝'.padEnd(10) +
      '已编辑'.padEnd(10) +
      '已合并'
  );
  console.log('-'.repeat(80));

  for (const stat of stats) {
    console.log(
      stat.topic_name.padEnd(30) +
        stat.pending.toString().padEnd(10) +
        stat.approved.toString().padEnd(10) +
        stat.rejected.toString().padEnd(10) +
        stat.edited.toString().padEnd(10) +
        (stat.merged || 0).toString()
    );
  }

  console.log('='.repeat(80) + '\n');
}

/**
 * 显示单个 Q&A
 */
function displayQA(item: PendingQA) {
  console.log(`主题: ${item.topic_name}`);
  console.log(`标签: ${item.tags || 'N/A'}`);
  console.log(`来源: ${item.source_session}`);
  console.log(`时间: ${item.source_time}`);
  console.log(`相关人: ${item.related_users}`);

  if (item.auto_quality_score) {
    console.log(`质量评分: ${item.auto_quality_score.toFixed(2)}/5.0`);
  }

  console.log('\n问题:');
  console.log('-'.repeat(80));
  console.log(item.question);

  console.log('\n答案:');
  console.log('-'.repeat(80));
  console.log(item.answer);
  console.log('-'.repeat(80));
}

/**
 * 批准 Q&A（写入正式库）
 */
function approveQA(db: Database.Database, item: PendingQA, reviewer: string = 'admin'): boolean {
  // 检查 knowledge 表中是否已存在相同问题
  const existing = db.prepare(
    'SELECT id, question FROM knowledge WHERE question = ?'
  ).get(item.question) as { id: string; question: string } | undefined;

  if (existing) {
    console.log(`\n⚠ 知识库中已存在相同问题（ID: ${existing.id.slice(0, 8)}），跳过写入`);
    // 仍然标记为 approved，避免重复审核
    db.prepare(`
      UPDATE knowledge_pending
      SET review_status = 'approved'
      WHERE id = ?
    `).run(item.id);
    return false;
  }

  const tx = db.transaction(() => {
    // 1. 写入正式库
    // create_time 使用 source_time (消息原始时间)，以便反映知识产生的实际时间
    // update_time 也使用 source_time，以便后续按 update_time 排序/计算权重时，反映的是知识的时效性
    const createdAt = item.source_time || new Date().toISOString();
    const updatedAt = createdAt;

    db.prepare(`
      INSERT INTO knowledge
      (id, question, answer, tags, related_users, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      item.question,
      item.answer,
      item.tags,
      item.related_users,
      'admin-001',
      createdAt,
      updatedAt
    );

    // 2. 更新待审核表状态
    db.prepare(`
      UPDATE knowledge_pending
      SET review_status = 'approved'
      WHERE id = ?
    `).run(item.id);

    // 3. 记录审核日志
    db.prepare(`
      INSERT INTO knowledge_review_log
      (pending_id, reviewer, action, reviewed_at)
      VALUES (?, ?, 'approve', ?)
    `).run(item.id, reviewer, new Date().toISOString());
  });

  tx();
  return true;
}
 */
function editQA(
  db: Database.Database,
  item: PendingQA,
  newQuestion: string,
  newAnswer: string,
  reviewer: string = 'admin'
) {
  const tx = db.transaction(() => {
    // 1. 更新待审核表内容
    db.prepare(`
      UPDATE knowledge_pending
      SET question = ?, answer = ?, review_status = 'edited'
      WHERE id = ?
    `).run(newQuestion, newAnswer, item.id);

    // 2. 记录审核日志
    db.prepare(`
      INSERT INTO knowledge_review_log
      (pending_id, reviewer, action, comment, reviewed_at)
      VALUES (?, ?, 'edit', ?, ?)
    `).run(
      item.id,
      reviewer,
      `问题: ${item.question.substring(0, 50)}... → ${newQuestion.substring(0, 50)}...`,
      new Date().toISOString()
    );
  });

  tx();
}

/**
 * 拒绝 Q&A
 */
function rejectQA(
  db: Database.Database,
  item: PendingQA,
  comment: string,
  reviewer: string = 'admin'
) {
  const tx = db.transaction(() => {
    // 1. 更新待审核表状态
    db.prepare(`
      UPDATE knowledge_pending
      SET review_status = 'rejected'
      WHERE id = ?
    `).run(item.id);

    // 2. 记录审核日志
    db.prepare(`
      INSERT INTO knowledge_review_log
      (pending_id, reviewer, action, comment, reviewed_at)
      VALUES (?, ?, 'reject', ?, ?)
    `).run(item.id, reviewer, comment, new Date().toISOString());
  });

  tx();
}

/**
 * 获取指定主题的待审核 Q&A
 */
function getPendingByTopic(db: Database.Database, topic: string): PendingQA[] {
  return db
    .prepare(`
    SELECT * FROM knowledge_pending
    WHERE topic_name = ? AND review_status = 'pending'
    ORDER BY auto_quality_score DESC, extracted_at DESC
  `)
    .all(topic) as PendingQA[];
}

/**
 * 获取所有待审核 Q&A
 */
function getAllPending(db: Database.Database): PendingQA[] {
  return db
    .prepare(`
    SELECT * FROM knowledge_pending
    WHERE review_status = 'pending'
    ORDER BY review_priority DESC, auto_quality_score DESC, extracted_at DESC
    LIMIT 50
  `)
    .all() as PendingQA[];
}

// ============ 交互式输入辅助函数 ============

function askReviewAction(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question('\n操作 [a=批准, e=编辑, r=拒绝, s=跳过, q=退出]: ', answer => {
      rl.close();
      const action = answer.trim().toLowerCase();

      if (action === 'a') resolve('approve');
      else if (action === 'e') resolve('edit');
      else if (action === 'r') resolve('reject');
      else if (action === 's') resolve('skip');
      else if (action === 'q') resolve('quit');
      else resolve('skip');
    });
  });
}

function askComment(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(`${prompt}: `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askEdit(prompt: string, currentValue: string): Promise<string> {
  return new Promise(resolve => {
    console.log(`\n当前内容:\n${currentValue}\n`);
    console.log(`${prompt}（多行输入，空行结束；直接回车保持不变）`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    const lines: string[] = [];
    let firstLine = true;

    rl.prompt();

    rl.on('line', (line: string) => {
      if (firstLine && line === '') {
        rl.close();
        resolve(currentValue);
        return;
      }
      firstLine = false;

      if (line === '') {
        rl.close();
        const result = lines.join('\n').trim();
        resolve(result === '' ? currentValue : result);
        return;
      }

      lines.push(line);
      rl.prompt();
    });
  });
}

// 运行审核
const topicName = process.argv[2];
reviewQA(topicName).catch(console.error);
