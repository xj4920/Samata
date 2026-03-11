/**
 * QA 质量评分模块
 * 对指定主题下未评分的 pending QA 进行 LLM 质量评分
 */
import Database from 'better-sqlite3';
import { initProviders } from '../llm/provider.js';
import { scoreQAQuality } from '../utils/qa-quality-scorer.js';

const DB_PATH = './data/yanyu.db';

export async function scoreTopicQA(topicName: string) {
  await initProviders();

  const db = new Database(DB_PATH);

  const items = db.prepare(`
    SELECT id, question, answer, source_session, source_time, related_users
    FROM knowledge_pending
    WHERE topic_name = ? AND review_status = 'pending' AND auto_quality_score IS NULL
    ORDER BY extracted_at
  `).all(topicName) as any[];

  if (items.length === 0) {
    console.log(`\n主题 [${topicName}] 没有需要评分的 QA`);
    db.close();
    return;
  }

  console.log(`\n评分主题: ${topicName}，共 ${items.length} 条待评分\n`);

  let scored = 0;
  for (const item of items) {
    const result = await scoreQAQuality({
      question: item.question,
      answer: item.answer,
      time: item.source_time || '',
      session: item.source_session || '',
      questioner: '',
      answerer: '',
    });

    db.prepare('UPDATE knowledge_pending SET auto_quality_score = ? WHERE id = ?')
      .run(result.score, item.id);

    scored++;
    console.log(`  [${scored}/${items.length}] ${result.score}/5 - ${item.question.substring(0, 60)}...`);
    console.log(`    ${result.reason}`);

    // 避免 API 限流
    await new Promise(r => setTimeout(r, 1000));
  }

  db.close();
  console.log(`\n✓ 评分完成，共 ${scored} 条\n`);
}
