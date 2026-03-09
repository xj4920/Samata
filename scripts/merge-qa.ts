/**
 * Q&A 相似项合并工具
 * 在提取和审核之间运行，将语义相近的 pending QA 合并，减少 review 工作量
 *
 * 流程: 提取 → 合并 → 审核 → 入库
 *
 * Usage: npx tsx scripts/merge-qa.ts [topic-name]
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
  source_message_ids: string;
  topic_name: string;
  auto_quality_score: number | null;
}

interface SimilarGroup {
  indices: number[];
  reason: string;
  suggested_primary: number;
}

// ============ 数据库迁移 ============

function runMigrations(db: Database.Database) {
  // 添加 merged_into_id 列（幂等）
  try {
    db.exec('ALTER TABLE knowledge_pending ADD COLUMN merged_into_id TEXT');
  } catch {
    // 列已存在，忽略
  }

  // 添加索引
  db.exec('CREATE INDEX IF NOT EXISTS idx_pending_merged_into ON knowledge_pending(merged_into_id)');

  // 重建 review_stats 视图（加入 merged 计数）
  db.exec('DROP VIEW IF EXISTS review_stats');
  db.exec(`
    CREATE VIEW review_stats AS
    SELECT
      topic_name,
      COUNT(*) as total,
      SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN review_status = 'edited' THEN 1 ELSE 0 END) as edited,
      SUM(CASE WHEN review_status = 'merged' THEN 1 ELSE 0 END) as merged
    FROM knowledge_pending
    GROUP BY topic_name
  `);
}

// ============ 主函数 ============

async function mergeQA(topicName?: string) {
  await initProviders();

  console.log(`相似性检测模型: ${getModelForTask('classification')}`);
  console.log(`问题合并模型:   ${getModelForTask('summary')}`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  runMigrations(db);

  // 显示统计
  showMergeStats(db);

  // 获取需要处理的 topic 列表
  const topics = getTopicsWithPending(db, topicName);

  if (topics.length === 0) {
    console.log('\n没有可合并的主题（需至少 3 条 pending QA）');
    db.close();
    return;
  }

  let totalMerged = 0;
  let totalGroups = 0;
  let totalSkipped = 0;

  for (const topic of topics) {
    const result = await processTopicMerge(db, topic);
    totalMerged += result.merged;
    totalGroups += result.groups;
    totalSkipped += result.skipped;

    if (result.quit) break;
  }

  db.close();

  // 最终统计
  console.log('\n' + '='.repeat(80));
  console.log('合并完成');
  console.log('='.repeat(80));
  console.log(`发现相似组: ${totalGroups}`);
  console.log(`已合并: ${totalMerged} 项`);
  console.log(`跳过: ${totalSkipped} 组`);
  console.log('='.repeat(80) + '\n');
}

// ============ 统计显示 ============

function showMergeStats(db: Database.Database) {
  const stats = db.prepare('SELECT * FROM review_stats').all() as any[];

  console.log('\n合并统计');
  console.log('='.repeat(80));
  console.log(
    '主题'.padEnd(30) +
    '待审核'.padEnd(10) +
    '已合并'.padEnd(10) +
    '已批准'.padEnd(10) +
    '已拒绝'
  );
  console.log('-'.repeat(80));

  for (const stat of stats) {
    console.log(
      stat.topic_name.padEnd(30) +
      stat.pending.toString().padEnd(10) +
      (stat.merged || 0).toString().padEnd(10) +
      stat.approved.toString().padEnd(10) +
      stat.rejected.toString()
    );
  }

  console.log('='.repeat(80) + '\n');
}

function getTopicsWithPending(db: Database.Database, topicName?: string): string[] {
  if (topicName) {
    const count = db.prepare(`
      SELECT COUNT(*) as cnt FROM knowledge_pending
      WHERE topic_name = ? AND review_status = 'pending'
    `).get(topicName) as any;

    return count.cnt >= 3 ? [topicName] : [];
  }

  const rows = db.prepare(`
    SELECT topic_name, COUNT(*) as cnt FROM knowledge_pending
    WHERE review_status = 'pending'
    GROUP BY topic_name
    HAVING cnt >= 3
    ORDER BY cnt DESC
  `).all() as any[];

  return rows.map((r: any) => r.topic_name);
}

// ============ 主题处理 ============

async function processTopicMerge(
  db: Database.Database,
  topicName: string
): Promise<{ merged: number; groups: number; skipped: number; quit: boolean }> {
  const items = db.prepare(`
    SELECT * FROM knowledge_pending
    WHERE topic_name = ? AND review_status = 'pending'
    ORDER BY auto_quality_score DESC, extracted_at DESC
  `).all(topicName) as PendingQA[];

  console.log('='.repeat(80));
  console.log(`主题: ${topicName} (${items.length} 个待审核)`);
  console.log('='.repeat(80));

  if (items.length < 3) {
    console.log('  待审核数量不足 3，跳过\n');
    return { merged: 0, groups: 0, skipped: 0, quit: false };
  }

  // 分批检测相似组
  console.log('正在检测相似问题...');
  const allGroups = await detectSimilarGroups(items);

  if (allGroups.length === 0) {
    console.log('  未发现相似问题\n');
    return { merged: 0, groups: 0, skipped: 0, quit: false };
  }

  console.log(`发现 ${allGroups.length} 组相似问题\n`);

  let merged = 0;
  let skipped = 0;

  for (let i = 0; i < allGroups.length; i++) {
    const group = allGroups[i];
    const groupItems = group.indices.map(idx => items[idx]);

    console.log('\n' + '='.repeat(80));
    console.log(`相似组 #${i + 1}/${allGroups.length} (${groupItems.length} 个问题)`);
    console.log('='.repeat(80));

    displayMergeGroup(groupItems, group);

    const action = await askMergeAction();

    if (action === 'auto') {
      const primaryIdx = selectPrimary(groupItems, group.suggested_primary, group.indices);
      const primary = groupItems[primaryIdx];
      const others = groupItems.filter((_, idx) => idx !== primaryIdx);
      console.log('\n正在用 LLM 精炼问题...');
      const refined = await refineQuestionWithLLM(groupItems);
      const result = executeMerge(db, primary, others, refined);
      merged += others.length;
      printMergeResult(result, others.length);
    } else if (action === 'pick') {
      const picked = await askPickPrimary(groupItems.length);
      if (picked >= 0) {
        const primary = groupItems[picked];
        const others = groupItems.filter((_, idx) => idx !== picked);
        console.log('\n正在用 LLM 精炼问题...');
        const refined = await refineQuestionWithLLM(groupItems);
        const result = executeMerge(db, primary, others, refined);
        merged += others.length;
        printMergeResult(result, others.length);
      } else {
        skipped++;
        console.log('  已跳过');
      }
    } else if (action === 'combine') {
      const primaryIdx = selectPrimary(groupItems, group.suggested_primary, group.indices);
      const primary = groupItems[primaryIdx];
      const others = groupItems.filter((_, idx) => idx !== primaryIdx);
      console.log('\n正在用 LLM 合并问题和答案...');
      const combined = await combineQAWithLLM(groupItems);
      const result = executeMerge(db, primary, others, combined.question, combined.answer);
      merged += others.length;
      printMergeResult(result, others.length);
    } else if (action === 'skip') {
      skipped++;
      console.log('  已跳过');
    } else if (action === 'quit') {
      return { merged, groups: allGroups.length, skipped, quit: true };
    }
  }

  return { merged, groups: allGroups.length, skipped, quit: false };
}

// ============ LLM 相似性检测 ============

/**
 * 从 LLM 响应中提取 JSON 数组
 * 处理各种返回格式：纯 JSON、markdown 代码块、前后带文字等
 */
function extractJsonArray(raw: string): string | null {
  let text = raw.trim();

  // 1. 去除 <think> 标签
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // 2. 尝试从 markdown 代码块中提取
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  // 3. 定位第一个 [ 和最后一个 ]
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) {
    return null;
  }
  text = text.substring(firstBracket, lastBracket + 1);

  // 4. 修复常见 JSON 错误
  text = text
    .replace(/,\s*]/g, ']')   // 移除数组末尾多余逗号
    .replace(/,\s*}/g, '}')   // 移除对象末尾多余逗号
    .trim();

  // 5. 校验括号匹配
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

async function detectSimilarGroups(items: PendingQA[]): Promise<SimilarGroup[]> {
  const BATCH_SIZE = 30;
  const batches: PendingQA[][] = [];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }

  const allGroups: SimilarGroup[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const offset = b * BATCH_SIZE;

    console.log(`  批次 ${b + 1}/${batches.length} (${batch.length} 条)`);

    const groups = await findSimilarInBatchWithRetry(batch, offset);
    allGroups.push(...groups);

    if (b < batches.length - 1) {
      await sleep(100);
    }
  }

  // 合并传递性相似组（如 [0,1] + [1,2] → [0,1,2]）
  return mergeTransitiveGroups(allGroups);
}

async function findSimilarInBatchWithRetry(
  items: PendingQA[],
  indexOffset: number,
  maxRetries: number = 3
): Promise<SimilarGroup[]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const groups = await findSimilarInBatch(items, indexOffset);
    // findSimilarInBatch 内部已 catch，失败返回 []
    // 但如果是 JSON 解析失败我们希望重试，所以用一个标记
    if (groups.length > 0 || attempt === maxRetries) {
      return groups;
    }
    // 第一次返回空可能是真的没有相似组，但也可能是解析失败
    // 我们只在出错时重试（通过 _lastBatchHadError 标记）
    if (!_lastBatchHadError) return groups;
    const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
    console.log(`    等待 ${waitTime}ms 后重试 (${attempt}/${maxRetries})...`);
    await sleep(waitTime);
  }
  return [];
}

let _lastBatchHadError = false;

async function findSimilarInBatch(
  items: PendingQA[],
  indexOffset: number
): Promise<SimilarGroup[]> {
  const questionList = items
    .map((item, i) => `[${i + indexOffset}] ${item.question}`)
    .join('\n');

  const prompt = `你是一个知识库去重专家。以下是待审核的知识库问题列表。
请找出语义相似或重复的问题，将它们分组。

**判定标准：**
- 核心问题相同，只是表述方式不同（如"怎么做X"和"X的步骤是什么"）
- 问的是同一个知识点，即使具体场景略有不同
- 答案会高度重叠的问题

**不应合并的情况：**
- 虽然涉及相同技术/业务领域，但问的是不同方面
- 问题的深度或范围明显不同（如"X是什么"vs"X的高级配置方法"）
- 不同错误码/错误场景的排查

问题列表：
${questionList}

请以 JSON 数组格式返回相似组，每个元素包含：
- indices: 相似问题的编号数组（至少2个）
- reason: 判定为相似的原因
- suggested_primary: 建议保留的问题编号（选择表述最清晰、最完整的）

如果没有发现相似组，返回空数组 []。
只返回 JSON，不要其他说明。`;

  try {
    const provider = getProviderForTask('classification');
    const model = getModelForTask('classification');

    const response = await provider.createMessage({
      model,
      max_tokens: 4000,
      system: '你是一个知识库去重专家。请直接返回 JSON 结果。',
      tools: [],
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') return [];

    _lastBatchHadError = false;

    const jsonText = extractJsonArray(content.text);
    if (!jsonText) {
      _lastBatchHadError = true;
      console.error(`    无法从 LLM 响应中提取 JSON 数组`);
      console.error(`    原始响应前 300 字符:\n${content.text.substring(0, 300)}`);
      return [];
    }

    const groups: SimilarGroup[] = JSON.parse(jsonText);

    // 校验索引有效性
    const maxIndex = indexOffset + items.length - 1;
    return groups.filter(g => {
      if (!Array.isArray(g.indices) || g.indices.length < 2) return false;
      return g.indices.every(i => typeof i === 'number' && i >= indexOffset && i <= maxIndex);
    });
  } catch (err: any) {
    _lastBatchHadError = true;
    console.error(`    相似性检测失败: ${err.message}`);
    return [];
  }
}

/**
 * 合并传递性相似组
 * 如 [0,1] + [1,2] → [0,1,2]
 */
function mergeTransitiveGroups(groups: SimilarGroup[]): SimilarGroup[] {
  if (groups.length === 0) return [];

  // 使用 Union-Find 算法
  const parent = new Map<number, number>();

  function find(x: number): number {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  }

  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // 保存每个组的 reason 和 suggested_primary
  const groupInfo = new Map<string, { reason: string; suggested_primary: number }>();

  for (const group of groups) {
    const key = group.indices.sort((a, b) => a - b).join(',');
    groupInfo.set(key, { reason: group.reason, suggested_primary: group.suggested_primary });

    for (let i = 1; i < group.indices.length; i++) {
      union(group.indices[0], group.indices[i]);
    }
  }

  // 收集合并后的组
  const merged = new Map<number, number[]>();
  for (const idx of parent.keys()) {
    const root = find(idx);
    if (!merged.has(root)) merged.set(root, []);
    merged.get(root)!.push(idx);
  }

  const result: SimilarGroup[] = [];
  for (const [_, indices] of merged) {
    if (indices.length < 2) continue;
    indices.sort((a, b) => a - b);

    // 从原始组中找最佳的 reason 和 suggested_primary
    let bestReason = '传递性合并';
    let bestPrimary = indices[0];

    for (const group of groups) {
      const groupIndices = new Set(group.indices);
      if (indices.some(i => groupIndices.has(i))) {
        bestReason = group.reason;
        if (indices.includes(group.suggested_primary)) {
          bestPrimary = group.suggested_primary;
        }
      }
    }

    result.push({
      indices,
      reason: bestReason,
      suggested_primary: bestPrimary,
    });
  }

  return result;
}

// ============ 显示和交互 ============

function displayMergeGroup(items: PendingQA[], group: SimilarGroup) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isPrimary = group.indices[i] === group.suggested_primary;
    const marker = isPrimary ? ' [建议保留]' : '';
    const score = item.auto_quality_score ? ` 质量: ${item.auto_quality_score.toFixed(1)}` : '';

    console.log(`\n  [${i + 1}]${marker}${score}`);
    console.log(`      Q: ${item.question}`);
    console.log(`      A: ${item.answer.length > 120 ? item.answer.substring(0, 120) + '...' : item.answer}`);
    console.log(`      来源: ${item.source_session} | ${item.source_time}`);
  }

  console.log(`\n  相似原因: ${group.reason}`);
}

function printMergeResult(result: MergeResult, mergedCount: number) {
  console.log('\n' + '-'.repeat(80));
  console.log(`  Q: ${result.question}`);
  console.log(`  A: ${result.answer.length > 200 ? result.answer.substring(0, 200) + '...' : result.answer}`);
  console.log(`  标签: ${result.tags || '(无)'}`);
  console.log(`  相关用户: ${result.related_users || '(无)'}`);
  console.log(`  来源时间: ${result.source_time || '(无)'}`);
  console.log('-'.repeat(80));
  console.log(`已合并 ${mergedCount} 项`);
}

function selectPrimary(items: PendingQA[], suggestedPrimary: number, indices: number[]): number {
  // 找到 suggested_primary 在 items 数组中的位置
  const suggestedIdx = indices.indexOf(suggestedPrimary);
  if (suggestedIdx >= 0) return suggestedIdx;

  // fallback: 质量评分最高
  let bestIdx = 0;
  let bestScore = items[0].auto_quality_score || 0;
  for (let i = 1; i < items.length; i++) {
    const score = items[i].auto_quality_score || 0;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ============ 合并执行 ============

interface MergeResult {
  question: string;
  answer: string;
  tags: string;
  related_users: string;
  source_time: string;
}

function executeMerge(
  db: Database.Database,
  primary: PendingQA,
  mergedItems: PendingQA[],
  updatedQuestion?: string,
  updatedAnswer?: string
): MergeResult {
  let result: MergeResult;

  const tx = db.transaction(() => {
    // 1. 先标记被合并项（避免后续更新主项 question 时触发 UNIQUE 约束冲突）
    for (const item of mergedItems) {
      db.prepare(`
        UPDATE knowledge_pending
        SET review_status = 'merged', merged_into_id = ?, question = question || ' [merged:' || id || ']'
        WHERE id = ?
      `).run(primary.id, item.id);
    }

    // 2. 更新主项内容（如有编辑/合并答案）
    if (updatedQuestion || updatedAnswer) {
      db.prepare(`
        UPDATE knowledge_pending
        SET question = COALESCE(?, question), answer = COALESCE(?, answer)
        WHERE id = ?
      `).run(updatedQuestion || null, updatedAnswer || null, primary.id);
    }

    // 3. 合并 source_message_ids
    const allSourceIds = new Set<string>();
    try {
      const existing = JSON.parse(primary.source_message_ids || '[]');
      existing.forEach((id: string) => allSourceIds.add(id));
    } catch {}
    for (const item of mergedItems) {
      try {
        const ids = JSON.parse(item.source_message_ids || '[]');
        ids.forEach((id: string) => allSourceIds.add(id));
      } catch {}
    }
    db.prepare(`
      UPDATE knowledge_pending SET source_message_ids = ? WHERE id = ?
    `).run(JSON.stringify([...allSourceIds]), primary.id);

    // 4. 合并 tags
    const allTags = new Set<string>();
    [primary, ...mergedItems].forEach(item => {
      (item.tags || '').split(',').filter(Boolean).forEach(t => allTags.add(t.trim()));
    });
    db.prepare(`
      UPDATE knowledge_pending SET tags = ? WHERE id = ?
    `).run([...allTags].join(','), primary.id);

    // 5. 合并 related_users（保留出现频次最高的回答者，最多2位）
    const userFreq = new Map<string, number>();
    [primary, ...mergedItems].forEach(item => {
      (item.related_users || '').split(',').filter(Boolean).forEach(u => {
        const name = u.trim();
        userFreq.set(name, (userFreq.get(name) || 0) + 1);
      });
    });
    const topUsers = [...userFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([name]) => name);
    db.prepare(`
      UPDATE knowledge_pending SET related_users = ? WHERE id = ?
    `).run(topUsers.join(','), primary.id);

    // 6. source_time 取最早时间
    const allTimes = [primary, ...mergedItems]
      .map(item => item.source_time)
      .filter(Boolean)
      .sort();
    if (allTimes.length > 0 && allTimes[0] < (primary.source_time || '')) {
      db.prepare(`
        UPDATE knowledge_pending SET source_time = ? WHERE id = ?
      `).run(allTimes[0], primary.id);
    }

    // 7. 记录审核日志（被合并项）
    const now = new Date().toISOString();
    for (const item of mergedItems) {
      db.prepare(`
        INSERT INTO knowledge_review_log
        (pending_id, reviewer, action, comment, reviewed_at)
        VALUES (?, ?, 'merge', ?, ?)
      `).run(
        item.id,
        'admin',
        `合并到 ${primary.id} | 原问题: ${item.question.substring(0, 80)}`,
        now
      );
    }

    // 8. 记录审核日志（主项）
    db.prepare(`
      INSERT INTO knowledge_review_log
      (pending_id, reviewer, action, comment, reviewed_at)
      VALUES (?, ?, 'merge-primary', ?, ?)
    `).run(
      primary.id,
      'admin',
      `合并了 ${mergedItems.length} 个相似项: ${mergedItems.map(i => i.id).join(', ')}`,
      now
    );

    // 组装合并结果
    const finalTime = (allTimes.length > 0 && allTimes[0] < (primary.source_time || ''))
      ? allTimes[0] : primary.source_time;
    result = {
      question: updatedQuestion || primary.question,
      answer: updatedAnswer || primary.answer,
      tags: [...allTags].join(','),
      related_users: topUsers.join(','),
      source_time: finalTime,
    };
  });

  tx();
  return result!;
}

// ============ LLM 问题精炼与答案合并 ============

/**
 * 用 LLM 将多个相似问题精炼为一个最佳问题
 */
async function refineQuestionWithLLM(items: PendingQA[]): Promise<string> {
  const questionList = items
    .map((item, i) => `${i + 1}. ${item.question}`)
    .join('\n');

  const prompt = `以下是多个语义相似的知识库问题，请将它们合并精炼为一个最佳问题。

要求：
- 涵盖所有问题的关键信息点
- 表述清晰、简洁、专业
- 不要遗漏任何问题中提到的具体场景或条件
- 直接返回精炼后的问题文本，不要编号、引号或其他格式

相似问题：
${questionList}`;

  try {
    const provider = getProviderForTask('summary');
    const model = getModelForTask('summary');

    const response = await provider.createMessage({
      model,
      max_tokens: 500,
      system: '你是一个知识库编辑专家。请直接返回精炼后的问题，不要任何额外说明。',
      tools: [],
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type === 'text') {
      let text = content.text.trim();
      text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (text) return text;
    }
  } catch (err: any) {
    console.error(`  LLM 精炼问题失败: ${err.message}`);
  }

  // fallback: 选质量最高的原始问题
  const best = [...items].sort((a, b) => (b.auto_quality_score || 0) - (a.auto_quality_score || 0));
  return best[0].question;
}

/**
 * 用 LLM 同时合并问题和答案
 */
async function combineQAWithLLM(items: PendingQA[]): Promise<{ question: string; answer: string }> {
  const qaText = items
    .map((item, i) => `问题 ${i + 1}: ${item.question}\n答案 ${i + 1}:\n${item.answer}`)
    .join('\n\n');

  const prompt = `以下是多组语义相似的知识库 Q&A，请合并为一组最佳 Q&A。

要求：
- 问题：涵盖所有问题的关键信息点，表述清晰简洁专业
- 答案：保留所有独特的信息点，去除重复内容，组织成结构清晰的回答

请严格按以下格式返回，不要添加任何其他内容：
【问题】
合并后的问题
【答案】
合并后的答案

${qaText}`;

  try {
    const provider = getProviderForTask('summary');
    const model = getModelForTask('summary');

    const response = await provider.createMessage({
      model,
      max_tokens: 4000,
      system: '你是一个知识库编辑专家，擅长合并和整理知识内容。请严格按指定格式返回。',
      tools: [],
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type === 'text') {
      let text = content.text.trim();
      text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      // 用分隔符提取问题和答案
      const questionMatch = text.match(/【问题】\s*([\s\S]*?)(?=【答案】)/);
      const answerMatch = text.match(/【答案】\s*([\s\S]*)/);
      if (questionMatch && answerMatch) {
        const question = questionMatch[1].trim();
        const answer = answerMatch[1].trim();
        if (question && answer) {
          return { question, answer };
        }
      }
    }
  } catch (err: any) {
    console.error(`  LLM 合并 Q&A 失败: ${err.message}`);
  }

  // fallback: 分别处理
  const refinedQuestion = await refineQuestionWithLLM(items);
  const sorted = [...items].sort((a, b) => (b.auto_quality_score || 0) - (a.auto_quality_score || 0));
  const fallbackAnswer = sorted
    .map((item, i) => i === 0 ? item.answer : `\n\n补充（来源: ${item.source_session}）:\n${item.answer}`)
    .join('');
  return { question: refinedQuestion, answer: fallbackAnswer };
}

// ============ 交互式输入 ============

function askMergeAction(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question('\n操作 [a=自动合并, p=手动选主答案, c=合并问题+答案, s=跳过, q=退出]: ', answer => {
      rl.close();
      const action = answer.trim().toLowerCase();

      if (action === 'a') resolve('auto');
      else if (action === 'p') resolve('pick');
      else if (action === 'c') resolve('combine');
      else if (action === 's') resolve('skip');
      else if (action === 'q') resolve('quit');
      else resolve('skip');
    });
  });
}

function askPickPrimary(count: number): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(`选择保留项编号 (1-${count}，0=取消): `, answer => {
      rl.close();
      const num = parseInt(answer.trim(), 10);
      if (isNaN(num) || num < 0 || num > count) {
        resolve(-1);
      } else {
        resolve(num - 1); // 转为 0-based
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 运行合并
const topicName = process.argv[2];
mergeQA(topicName).catch(console.error);
