/**
 * 基于已拒绝 QA 扫描相似 pending 项
 * 加载 rejected QA，在 pending 中找语义相似项，逐个提示用户保留或拒绝
 *
 * Usage: npx tsx scripts/scan-rejected-similar.ts [topic-name]
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import readline from 'readline';
import { getProviderForTask, getModelForTask, initProviders } from '../src/llm/provider.js';

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

interface RejectedQA extends PendingQA {
  reject_reason: string | null;
}

interface SimilarMatch {
  pending_index: number;
  rejected_index: number;
  reason: string;
  confidence: 'high' | 'medium';
}

// ============ JSON 提取（复用 merge-qa 的逻辑） ============

function extractJsonArray(raw: string): string | null {
  let text = raw.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) {
    return null;
  }
  text = text.substring(firstBracket, lastBracket + 1);

  text = text
    .replace(/,\s*]/g, ']')
    .replace(/,\s*}/g, '}')
    .trim();

  let brackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of text) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }
  if (brackets !== 0) return null;

  return text;
}

// ============ 数据加载 ============

function loadRejectedQA(db: Database.Database, topicName?: string): RejectedQA[] {
  const sql = `
    SELECT kp.*, krl.comment as reject_reason
    FROM knowledge_pending kp
    LEFT JOIN (
      SELECT pending_id, comment,
        ROW_NUMBER() OVER (PARTITION BY pending_id ORDER BY reviewed_at DESC) as rn
      FROM knowledge_review_log
      WHERE action = 'reject'
    ) krl ON krl.pending_id = kp.id AND krl.rn = 1
    WHERE kp.review_status = 'rejected'
    ${topicName ? 'AND kp.topic_name = ?' : ''}
    ORDER BY kp.topic_name, kp.extracted_at DESC
  `;

  return (topicName
    ? db.prepare(sql).all(topicName)
    : db.prepare(sql).all()
  ) as RejectedQA[];
}

function loadPendingQA(db: Database.Database, topicName?: string): PendingQA[] {
  const sql = `
    SELECT * FROM knowledge_pending
    WHERE review_status = 'pending'
    ${topicName ? 'AND topic_name = ?' : ''}
    ORDER BY auto_quality_score DESC, extracted_at DESC
  `;

  return (topicName
    ? db.prepare(sql).all(topicName)
    : db.prepare(sql).all()
  ) as PendingQA[];
}

// ============ LLM 跨集合相似性检测 ============

async function detectCrossSimilarity(
  rejectedItems: RejectedQA[],
  pendingItems: PendingQA[]
): Promise<SimilarMatch[]> {
  const PENDING_BATCH_SIZE = 20;
  const allMatches: SimilarMatch[] = [];

  // rejected 作为参考集，pending 分批
  for (let i = 0; i < pendingItems.length; i += PENDING_BATCH_SIZE) {
    const pendingBatch = pendingItems.slice(i, i + PENDING_BATCH_SIZE);
    const batchNum = Math.floor(i / PENDING_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(pendingItems.length / PENDING_BATCH_SIZE);

    console.log(`  批次 ${batchNum}/${totalBatches} (${pendingBatch.length} 条待审核)`);

    const matches = await findCrossSimilarBatch(rejectedItems, pendingBatch, i);
    allMatches.push(...matches);

    if (i + PENDING_BATCH_SIZE < pendingItems.length) {
      await sleep(100);
    }
  }

  // 去重：每个 pending 只保留第一个匹配（置信度 high 优先）
  const seen = new Map<number, SimilarMatch>();
  for (const match of allMatches) {
    const existing = seen.get(match.pending_index);
    if (!existing) {
      seen.set(match.pending_index, match);
    } else if (match.confidence === 'high' && existing.confidence !== 'high') {
      seen.set(match.pending_index, match);
    }
  }

  return Array.from(seen.values()).sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
    return a.pending_index - b.pending_index;
  });
}

async function findCrossSimilarBatch(
  rejectedItems: RejectedQA[],
  pendingBatch: PendingQA[],
  pendingOffset: number
): Promise<SimilarMatch[]> {
  const rejectedList = rejectedItems
    .map((item, i) => {
      const reason = item.reject_reason ? ` | 拒绝原因: ${item.reject_reason}` : '';
      return `[R${i}] Q: ${item.question}${reason}`;
    })
    .join('\n');

  const pendingList = pendingBatch
    .map((item, i) => `[P${i + pendingOffset}] Q: ${item.question}`)
    .join('\n');

  const prompt = `你是一个知识库质量审核专家。以下有两组 Q&A：
- 【已拒绝组】：已被人工审核拒绝的 Q&A（附拒绝原因）
- 【待审核组】：尚未审核的 Q&A

请找出【待审核组】中与【已拒绝组】存在相似问题的项。

**判定标准：**
- 问题核心相同或高度相似（同一知识点、同类问题模式）
- 可能因为相同的原因被拒绝（如同样缺乏技术细节、同样是客户特定信息、同样过于宽泛等）
- 答案角度相同，只是换了表述方式

**不应匹配的情况：**
- 虽然涉及相同技术领域，但问的是不同知识点
- 待审核项质量明显高于被拒绝项，不存在相同缺陷

【已拒绝组】：
${rejectedList}

【待审核组】：
${pendingList}

返回 JSON 数组，每个元素：
- pending_index: 待审核项编号（P后的数字）
- rejected_index: 匹配的已拒绝项编号（R后的数字）
- reason: 为何判定相似
- confidence: "high" 或 "medium"（仅返回 high 和 medium 置信度的匹配）

没有匹配返回 []。只返回 JSON。`;

  try {
    const provider = getProviderForTask('classification');
    const model = getModelForTask('classification');

    const response = await provider.createMessage({
      model,
      max_tokens: 4000,
      system: '你是一个知识库质量审核专家。请直接返回 JSON 结果。',
      tools: [],
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') return [];

    const jsonText = extractJsonArray(content.text);
    if (!jsonText) {
      console.error(`    无法从 LLM 响应中提取 JSON 数组`);
      return [];
    }

    const matches: SimilarMatch[] = JSON.parse(jsonText);

    // 校验索引有效性
    const maxPending = pendingOffset + pendingBatch.length - 1;
    const maxRejected = rejectedItems.length - 1;

    return matches.filter(m => {
      if (typeof m.pending_index !== 'number' || typeof m.rejected_index !== 'number') return false;
      if (m.pending_index < pendingOffset || m.pending_index > maxPending) return false;
      if (m.rejected_index < 0 || m.rejected_index > maxRejected) return false;
      if (m.confidence !== 'high' && m.confidence !== 'medium') return false;
      return true;
    });
  } catch (err: any) {
    console.error(`    相似性检测失败: ${err.message}`);
    return [];
  }
}

// ============ 交互操作 ============

function displayMatch(
  idx: number,
  total: number,
  rejected: RejectedQA,
  pending: PendingQA,
  reason: string,
  confidence: string
) {
  console.log('\n' + '='.repeat(80));
  console.log(`发现相似项 #${idx + 1}/${total}  [置信度: ${confidence}]`);
  console.log('='.repeat(80));

  console.log('\n【已拒绝的 QA】');
  console.log(`  拒绝原因: ${rejected.reject_reason || '(未填写)'}`);
  console.log(`  主题: ${rejected.topic_name} | 来源: ${rejected.source_session}`);
  console.log(`  Q: ${rejected.question}`);
  const rejAnswer = rejected.answer.length > 120
    ? rejected.answer.substring(0, 120) + '...'
    : rejected.answer;
  console.log(`  A: ${rejAnswer}`);

  console.log('\n【相似的待审核 QA】');
  console.log(`  主题: ${pending.topic_name} | 来源: ${pending.source_session}`);
  if (pending.auto_quality_score) {
    console.log(`  质量评分: ${pending.auto_quality_score.toFixed(1)}/5.0`);
  }
  console.log(`  Q: ${pending.question}`);
  console.log(`  A: ${pending.answer}`);

  console.log(`\n  相似原因: ${reason}`);
  console.log('-'.repeat(80));
}

function rejectPendingQA(
  db: Database.Database,
  pending: PendingQA,
  rejectedId: string,
  similarReason: string
) {
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE knowledge_pending
      SET review_status = 'rejected'
      WHERE id = ?
    `).run(pending.id);

    db.prepare(`
      INSERT INTO knowledge_review_log
      (pending_id, reviewer, action, comment, reviewed_at)
      VALUES (?, ?, 'reject', ?, ?)
    `).run(
      pending.id,
      'admin',
      `基于相似拒绝项批量拒绝 | 参考: ${rejectedId} | 原因: ${similarReason}`,
      new Date().toISOString()
    );
  });

  tx();
}

function askAction(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question('\n操作 [r=拒绝, k=保留, q=退出]: ', answer => {
      rl.close();
      const action = answer.trim().toLowerCase();
      if (action === 'r') resolve('reject');
      else if (action === 'k') resolve('keep');
      else if (action === 'q') resolve('quit');
      else resolve('keep');
    });
  });
}

// ============ 主函数 ============

async function scanRejectedSimilar(topicName?: string) {
  await initProviders();
  console.log(`\n相似性检测模型: ${getModelForTask('classification')}`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 加载数据
  const rejectedItems = loadRejectedQA(db, topicName);
  const pendingItems = loadPendingQA(db, topicName);

  console.log(`\n已拒绝 QA: ${rejectedItems.length} 条`);
  console.log(`待审核 QA: ${pendingItems.length} 条`);

  if (rejectedItems.length === 0) {
    console.log('\n✓ 没有已拒绝的 QA，无需扫描');
    db.close();
    return;
  }
  if (pendingItems.length === 0) {
    console.log('\n✓ 没有待审核的 QA，无需扫描');
    db.close();
    return;
  }

  // LLM 跨集合检测
  console.log('\n正在检测相似项...');
  const matches = await detectCrossSimilarity(rejectedItems, pendingItems);

  if (matches.length === 0) {
    console.log('\n✓ 未发现与已拒绝 QA 相似的待审核项');
    db.close();
    return;
  }

  console.log(`\n发现 ${matches.length} 个相似项，开始逐个审核\n`);

  // 交互审核
  let rejectedCount = 0;
  let keptCount = 0;
  const processedPendingIds = new Set<string>();

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const rejected = rejectedItems[match.rejected_index];
    const pending = pendingItems[match.pending_index];

    // 跳过本轮已处理的
    if (processedPendingIds.has(pending.id)) continue;

    displayMatch(i, matches.length, rejected, pending, match.reason, match.confidence);

    const action = await askAction();

    if (action === 'reject') {
      rejectPendingQA(db, pending, rejected.id, match.reason);
      processedPendingIds.add(pending.id);
      rejectedCount++;
      console.log('✗ 已拒绝');
    } else if (action === 'keep') {
      processedPendingIds.add(pending.id);
      keptCount++;
      console.log('✓ 已保留');
    } else if (action === 'quit') {
      console.log('\n扫描已中断');
      break;
    }
  }

  db.close();

  // 最终统计
  console.log('\n' + '='.repeat(80));
  console.log('扫描完成');
  console.log('='.repeat(80));
  console.log(`扫描匹配: ${matches.length} 项`);
  console.log(`拒绝: ${rejectedCount}`);
  console.log(`保留: ${keptCount}`);
  console.log('='.repeat(80) + '\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 运行
const topicName = process.argv[2];
scanRejectedSimilar(topicName).catch(console.error);
