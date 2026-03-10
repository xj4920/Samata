/**
 * 增量提取脚本
 * 按主题跨群聚合消息，增量过滤，分窗口提取 Q&A，写入待审核表
 *
 * Usage: npx tsx scripts/incremental-extract.ts [topic-name]
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { fetchWeworkMessages, WeworkMessage } from '../src/commands/wework.js';
import { generateMessageFingerprint } from '../src/utils/message-fingerprint.js';
import { scoreQAQuality } from '../src/utils/qa-quality-scorer.js';
import { getProviderForTask, getModelForTask, initProviders } from '../src/llm/provider.js';
import { log } from '../src/utils/logger.js';
import { TOPICS, TopicConfig, getTopicsByPriority } from './topics-config.js';
import { generateTopicPrompt, getTopicPromptConfig } from '../src/utils/topic-prompts.js';
import { parseLLMJsonArray } from '../src/utils/json-repair.js';

const DB_PATH = './data/yanyu.db';
const EXTRACTION_VERSION = 1; // 每次修改提取逻辑时递增

interface ProcessedMessage {
  message_id: string;
  processed_topics: string;
  content_hash: string;
}

interface QAPairWithSources {
  question: string;
  answer: string;
  tags?: string[];
  time: string;
  questioner: string;
  answerer: string;
  session: string;
  context?: string;
  sourceMessageIds: string[];
}

/**
 * 主函数：增量提取指定主题的 Q&A
 */
async function incrementalExtract(topicName?: string, limit?: number) {
  console.log('\n' + '='.repeat(80));
  console.log('企微 Q&A 增量提取');
  if (limit) console.log(`限制提取数量: ${limit}`);
  console.log('='.repeat(80) + '\n');

  // 初始化 LLM providers
  await initProviders();

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 获取要处理的主题列表
  const topics = topicName
    ? TOPICS.filter(t => t.name === topicName)
    : getTopicsByPriority();

  if (topics.length === 0) {
    console.log(`❌ 未找到主题: ${topicName}`);
    db.close();
    return;
  }

  console.log(`待处理主题: ${topics.length} 个\n`);

  for (const topic of topics) {
    await extractTopicQA(db, topic, limit);
    await sleep(100); // 主题间间隔
  }

  db.close();
  console.log('\n' + '='.repeat(80));
  console.log('✓ 所有主题处理完成');
  console.log('='.repeat(80) + '\n');
}

/**
 * 提取单个主题的 Q&A
 */
async function extractTopicQA(db: Database.Database, topic: TopicConfig, limit?: number) {
  const promptConfig = getTopicPromptConfig(topic.name);

  console.log('='.repeat(80));
  console.log(`主题: ${topic.name} (优先级: ${topic.priority})`);
  console.log(`关键词: ${topic.keywords.join(', ')}`);
  console.log(`提取模板: 使用 [${promptConfig.topic}] 专属 Prompt 策略`);
  console.log(`内容重点: ${promptConfig.mustExtractTypes.length} 项必须提取内容, ${promptConfig.extractionFocus.length} 项提取标准`);
  console.log('='.repeat(80));

  // 1. 检查主题元数据
  const metadata = getTopicMetadata(db, topic.name);
  const needsReExtraction = metadata && metadata.extraction_version < EXTRACTION_VERSION;

  if (needsReExtraction) {
    console.log(`⚠️  提取逻辑已更新（v${metadata.extraction_version} → v${EXTRACTION_VERSION}），将重新提取`);
  }

  // 2. 跨群聚合消息
  console.log('\n📥 聚合消息...');
  const allMessages = await aggregateTopicMessages(topic);
  
  if (topic.relatedGroups && topic.relatedGroups.length > 0) {
    console.log(`  群组过滤: 仅限 [${topic.relatedGroups.join(', ')}] 相关群组`);
  }
  
  console.log(`  找到 ${allMessages.length} 条相关消息`);

  if (allMessages.length === 0) {
    console.log('  ✓ 无消息，跳过\n');
    updateTopicStatus(db, topic.name, 'completed');
    return;
  }

  // 3. 增量过滤
  console.log('\n🔍 增量过滤...');
  const { newMessages, updatedMessages } = filterUnprocessedMessages(
    db,
    allMessages,
    topic.name,
    needsReExtraction
  );

  console.log(`  新消息: ${newMessages.length} 条`);
  console.log(`  更新消息: ${updatedMessages.length} 条`);

  if (newMessages.length === 0 && updatedMessages.length === 0) {
    console.log('  ✓ 该主题已完全提取，无需处理\n');
    updateTopicStatus(db, topic.name, 'completed');
    return;
  }

  const messagesToProcess = [...newMessages, ...updatedMessages];

  // 4. 分窗口提取
  console.log('\n🤖 分窗口提取 Q&A...');
  const conversationGroups = groupByConversationWindow(messagesToProcess, 60);
  console.log(`  会话窗口: ${conversationGroups.length} 个`);

  const allQAPairs: QAPairWithSources[] = [];

  for (let i = 0; i < conversationGroups.length; i++) {
    const group = conversationGroups[i];
    console.log(`  处理窗口 ${i + 1}/${conversationGroups.length} (${group.length} 条消息)`);

    const result = await extractQAFromMessagesWithRetry(group, topic.name, 3);
    
    if (result.success) {
      allQAPairs.push(...result.qaPairs);
      // 只有成功提取时才标记为已处理
      markMessagesAsProcessed(db, group, topic.name);
      console.log(`    提取 ${result.qaPairs.length} 个 Q&A`);
      
      if (limit && allQAPairs.length >= limit) {
        console.log(`\n🛑 已达到提取限制 (${limit} 个)，停止处理后续窗口`);
        break;
      }
    } else {
      console.log(`    ⚠️  提取失败，消息未标记（下次运行会重试）`);
    }

    await sleep(100); // 窗口间隔
  }

  // 5. 去重
  const uniqueQAPairs = deduplicateQAPairs(allQAPairs);
  console.log(`\n  去重后: ${uniqueQAPairs.length} 个 Q&A`);

  // 6. 质量评分（可选）
  if (uniqueQAPairs.length > 0 && uniqueQAPairs.length <= 20) {
    console.log('\n📊 质量评分...');
    for (const qa of uniqueQAPairs) {
      const score = await scoreQAQuality(qa);
      (qa as any).auto_quality_score = score.score;
      await sleep(100);
    }
  }

  // 7. 保存到待审核表
  if (uniqueQAPairs.length > 0) {
    saveQAPairsToPending(db, uniqueQAPairs, topic.name);
    console.log(`\n✓ ${uniqueQAPairs.length} 个 Q&A 已保存到待审核表`);
  }

  // 8. 更新主题元数据
  updateTopicMetadata(db, topic.name, {
    lastExtractionTime: new Date().toISOString(),
    totalMessagesScanned: allMessages.length,
    totalQaExtracted: uniqueQAPairs.length,
    dateRangeStart: allMessages[0]?.time,
    dateRangeEnd: allMessages[allMessages.length - 1]?.time,
    extractionVersion: EXTRACTION_VERSION,
    status: 'completed',
    keywords: JSON.stringify(topic.keywords),
    relatedGroups: topic.relatedGroups ? JSON.stringify(topic.relatedGroups) : null,
  });

  console.log('✓ 主题处理完成\n');
}

/**
 * 跨群聚合主题相关消息
 */
async function aggregateTopicMessages(topic: TopicConfig): Promise<WeworkMessage[]> {
  const allMessages: WeworkMessage[] = [];
  const messageIds = new Set<string>();

  // 如果定义了 relatedGroups，则只在相关群组中进行过滤
  const targetGroups = topic.relatedGroups || [];

  for (const keyword of topic.keywords) {
    const messages = await fetchWeworkMessages({
      keyword: keyword.trim(),
      limit: 1000,
    });

    for (const msg of messages) {
      // 过滤非相关群组
      if (targetGroups.length > 0) {
        const isRelated = targetGroups.some(group => msg.session.includes(group));
        if (!isRelated) {
          continue;
        }
      }

      const msgId = `${msg.time}-${msg.sender}-${msg.content}`;
      if (!messageIds.has(msgId)) {
        messageIds.add(msgId);
        allMessages.push(msg);
      }
    }
  }

  // 按时间排序
  allMessages.sort((a, b) => a.time.localeCompare(b.time));

  // 时间范围过滤
  if (topic.timeRange) {
    return allMessages.filter(
      m => m.time >= topic.timeRange!.start && m.time <= topic.timeRange!.end + ' 23:59:59'
    );
  }

  return allMessages;
}

/**
 * 过滤未处理的消息
 */
function filterUnprocessedMessages(
  db: Database.Database,
  messages: WeworkMessage[],
  topicName: string,
  forceReExtract: boolean
): { newMessages: WeworkMessage[]; updatedMessages: WeworkMessage[] } {
  const newMessages: WeworkMessage[] = [];
  const updatedMessages: WeworkMessage[] = [];

  // 批量查询已处理的消息
  const messageIds = messages.map(m =>
    generateMessageFingerprint(m.time, m.sender, m.content, m.session).id
  );

  if (messageIds.length === 0) {
    return { newMessages, updatedMessages };
  }

  const placeholders = messageIds.map(() => '?').join(',');
  const processedMap = new Map<string, ProcessedMessage>();

  const rows = db
    .prepare(`
    SELECT message_id, processed_topics, content_hash
    FROM message_processing_log
    WHERE message_id IN (${placeholders})
  `)
    .all(...messageIds) as ProcessedMessage[];

  for (const row of rows) {
    processedMap.set(row.message_id, row);
  }

  // 分类消息
  for (const msg of messages) {
    const fp = generateMessageFingerprint(msg.time, msg.sender, msg.content, msg.session);
    const processed = processedMap.get(fp.id);

    if (!processed) {
      // 全新消息
      newMessages.push(msg);
    } else if (forceReExtract) {
      // 强制重新提取
      updatedMessages.push(msg);
    } else {
      const processedTopics = processed.processed_topics?.split(',') || [];

      if (!processedTopics.includes(topicName)) {
        // 该主题未处理过
        newMessages.push(msg);
      } else if (processed.content_hash !== fp.contentHash) {
        // 内容已变化
        updatedMessages.push(msg);
      }
    }
  }

  return { newMessages, updatedMessages };
}

/**
 * 固定窗口分组：每 100 条消息一组，仅在极端时间跨度时切分
 *
 * 分组策略：
 * 1. 固定 100 条消息为一组
 * 2. 仅在时间跨度 > 7 天时强制切分（避免混合完全不相关的时间段）
 */
function groupByConversationWindow(
  messages: WeworkMessage[],
  _windowMinutes: number // 保留参数兼容性
): WeworkMessage[][] {
  if (messages.length === 0) return [];

  const WINDOW_SIZE = 100; // 固定窗口大小
  const MAX_TIME_GAP_DAYS = 7; // 最大时间跨度（天）
  const groups: WeworkMessage[][] = [];
  let current: WeworkMessage[] = [];

  for (const msg of messages) {
    // 检查是否需要切分
    let shouldSplit = false;

    if (current.length === 0) {
      // 空窗口，直接加入
      current.push(msg);
      continue;
    }

    // 检查时间跨度
    const windowStartTime = new Date(current[0].time);
    const currTime = new Date(msg.time);
    const daysDiff = (currTime.getTime() - windowStartTime.getTime()) / (1000 * 60 * 60 * 24);

    if (daysDiff > MAX_TIME_GAP_DAYS) {
      // 时间跨度过大，强制切分
      shouldSplit = true;
    } else if (current.length >= WINDOW_SIZE) {
      // 达到窗口大小，切分
      shouldSplit = true;
    }

    if (shouldSplit) {
      groups.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * 判断是否应该切分对话
 */
function shouldSplitConversation(
  currentMsg: WeworkMessage,
  prevMsg: WeworkMessage,
  timeDiffMinutes: number,
  currentParticipants: Set<string>,
  currentKeywords: Set<string>
): boolean {
  // 1. 超长时间间隔（12 小时以上）→ 必定切分
  if (timeDiffMinutes > 720) {
    return true;
  }

  // 2. 短时间间隔（30 分钟内）→ 倾向不切分
  if (timeDiffMinutes <= 30) {
    return false;
  }

  // 3. 中等时间间隔（30-720 分钟）→ 综合判断
  const msgKeywords = extractKeywords(currentMsg.content);
  const topicSimilarity = calculateKeywordSimilarity(currentKeywords, msgKeywords);

  // 话题高度相关（相似度 > 0.3）→ 不切分
  if (topicSimilarity > 0.3) {
    return false;
  }

  // 参与人完全不同 + 话题不相关 + 间隔 > 60 分钟 → 切分
  const hasCommonParticipants = currentParticipants.has(currentMsg.sender);
  if (!hasCommonParticipants && topicSimilarity < 0.1 && timeDiffMinutes > 60) {
    return true;
  }

  // 默认：间隔 > 90 分钟 → 切分
  return timeDiffMinutes > 90;
}

/**
 * 提取消息关键词（简单实现：提取 2-10 字的中文词组）
 */
function extractKeywords(content: string): Set<string> {
  const keywords = new Set<string>();

  // 提取常见技术术语和业务词汇
  const patterns = [
    /FIX[协议]?/g,
    /API/gi,
    /接口/g,
    /报单/g,
    /行情/g,
    /撤单/g,
    /成交/g,
    /持仓/g,
    /资金/g,
    /风控/g,
    /测试/g,
    /生产/g,
    /环境/g,
    /配置/g,
    /问题/g,
    /错误/g,
    /[\u4e00-\u9fa5]{2,10}/g, // 2-10 字的中文词组
  ];

  for (const pattern of patterns) {
    const matches = content.match(pattern);
    if (matches) {
      matches.forEach(m => keywords.add(m.toLowerCase()));
    }
  }

  return keywords;
}

/**
 * 合并关键词集合（保留最近的关键词，限制大小）
 */
function mergeKeywords(set1: Set<string>, set2: Set<string>): Set<string> {
  const merged = new Set([...set1, ...set2]);

  // 限制关键词集合大小，避免过度膨胀
  if (merged.size > 50) {
    const arr = Array.from(merged);
    return new Set(arr.slice(-50)); // 保留最近的 50 个
  }

  return merged;
}

/**
 * 计算关键词相似度（Jaccard 系数）
 */
function calculateKeywordSimilarity(set1: Set<string>, set2: Set<string>): number {
  if (set1.size === 0 && set2.size === 0) return 1;
  if (set1.size === 0 || set2.size === 0) return 0;

  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  return intersection.size / union.size;
}

/**
 * 带重试的 Q&A 提取（处理网络错误和临时故障）
 */
async function extractQAFromMessagesWithRetry(
  messages: WeworkMessage[],
  topicName: string,
  maxRetries: number = 3
): Promise<{ success: boolean; qaPairs: QAPairWithSources[] }> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const qaPairs = await extractQAFromMessages(messages, topicName);
      return { success: true, qaPairs };
    } catch (err: any) {
      lastError = err;
      console.error(`    尝试 ${attempt}/${maxRetries} 失败: ${err.message}`);

      if (attempt < maxRetries) {
        const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 指数退避，最多 5 秒
        console.log(`    等待 ${waitTime}ms 后重试...`);
        await sleep(waitTime);
      }
    }
  }

  console.error(`    所有重试均失败，跳过此窗口`);
  return { success: false, qaPairs: [] };
}

/**
 * 从消息组中提取 Q&A
 */
async function extractQAFromMessages(
  messages: WeworkMessage[],
  topicName: string
): Promise<QAPairWithSources[]> {
  const conversationText = messages
    .map(m => `[${m.time}] [${m.session}] ${m.sender}: ${m.content}`)
    .join('\n');

  // 使用主题专属 prompt
  const prompt = generateTopicPrompt(conversationText, topicName, 10);

  try {
    const provider = getProviderForTask('extraction');
    const model = getModelForTask('extraction');

    const response = await provider.createMessage({
      model,
      max_tokens: 16000,
      system: '你是一个业务知识提取专家。请直接返回 JSON 结果，不要使用 markdown 代码块包裹。',
      tools: [],
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') return [];

    const qaPairs = parseLLMJsonArray<{
      question: string;
      answer: string;
      tags?: string[];
      time: string;
      questioner: string;
      answerer: string;
      context?: string;
    }>(content.text);

    // 关联消息 ID
    const messageIdMap = new Map<string, string>();
    for (const msg of messages) {
      const fp = generateMessageFingerprint(msg.time, msg.sender, msg.content, msg.session);
      messageIdMap.set(`${msg.time}-${msg.sender}`, fp.id);
    }

    return qaPairs.map(qa => {
      const sourceIds: string[] = [];
      const questionerId = messageIdMap.get(`${qa.time}-${qa.questioner}`);
      if (questionerId) sourceIds.push(questionerId);

      const msg = messages.find(m => m.time === qa.time);
      return {
        ...qa,
        session: msg?.session || messages[0]?.session || 'unknown',
        sourceMessageIds: sourceIds,
      };
    });
  } catch (err: any) {
    console.error(`    LLM 提取失败: ${err.message}`);
    throw err;
  }
}

/**
 * 标记消息为已处理
 */
function markMessagesAsProcessed(
  db: Database.Database,
  messages: WeworkMessage[],
  topicName: string
) {
  const upsert = db.prepare(`
    INSERT INTO message_processing_log
    (message_id, session, message_time, sender, content_hash, processed_topics, first_processed_at, last_processed_at, extraction_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(message_id) DO UPDATE SET
      processed_topics = CASE
        WHEN processed_topics LIKE '%' || ? || '%' THEN processed_topics
        ELSE COALESCE(processed_topics, '') || ',' || ?
      END,
      last_processed_at = ?,
      extraction_count = extraction_count + 1
  `);

  const now = new Date().toISOString();

  for (const msg of messages) {
    const fp = generateMessageFingerprint(msg.time, msg.sender, msg.content, msg.session);
    upsert.run(
      fp.id,
      msg.session,
      msg.time,
      msg.sender,
      fp.contentHash,
      topicName,
      now,
      now,
      topicName,
      topicName,
      now
    );
  }
}

/**
 * Q&A 去重
 */
function deduplicateQAPairs(qaPairs: QAPairWithSources[]): QAPairWithSources[] {
  const unique: QAPairWithSources[] = [];
  const seen = new Set<string>();

  for (const qa of qaPairs) {
    const key = qa.question.slice(0, 50);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(qa);
    }
  }

  return unique;
}

/**
 * 保存 Q&A 到待审核表
 */
function saveQAPairsToPending(
  db: Database.Database,
  qaPairs: QAPairWithSources[],
  topicName: string
) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO knowledge_pending
    (id, question, answer, tags, related_users, source_session, source_time,
     source_message_ids, topic_name, extraction_version, extracted_at, auto_quality_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();

  for (const qa of qaPairs) {
    const id = `pending-${topicName}-${qa.time}-${Date.now()}`;

    // 使用提取到的标签，如果为空则默认使用主题名
    const tags = qa.tags && qa.tags.length > 0 ? qa.tags.join(',') : topicName;

    const answerer = qa.answerer?.trim();
    const relatedUsers = answerer && answerer !== '未知' ? answerer : '';

    const sourceMessageIds = JSON.stringify(qa.sourceMessageIds || []);
    const qualityScore = (qa as any).auto_quality_score || null;

    insert.run(
      id,
      qa.question,
      qa.answer,
      tags,
      relatedUsers,
      qa.session,
      qa.time,
      sourceMessageIds,
      topicName,
      EXTRACTION_VERSION,
      now,
      qualityScore
    );
  }
}

/**
 * 获取主题元数据
 */
function getTopicMetadata(db: Database.Database, topicName: string): any {
  return db
    .prepare('SELECT * FROM topic_extraction_metadata WHERE topic_name = ?')
    .get(topicName);
}

/**
 * 更新主题元数据
 */
function updateTopicMetadata(
  db: Database.Database,
  topicName: string,
  data: {
    lastExtractionTime: string;
    totalMessagesScanned: number;
    totalQaExtracted: number;
    dateRangeStart: string;
    dateRangeEnd: string;
    extractionVersion: number;
    status: string;
    keywords: string;
    relatedGroups: string | null;
  }
) {
  db.prepare(`
    INSERT OR REPLACE INTO topic_extraction_metadata
    (topic_name, keywords, last_extraction_time, total_messages_scanned, total_qa_extracted,
     date_range_start, date_range_end, related_groups, extraction_version, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    topicName,
    data.keywords,
    data.lastExtractionTime,
    data.totalMessagesScanned,
    data.totalQaExtracted,
    data.dateRangeStart,
    data.dateRangeEnd,
    data.relatedGroups,
    data.extractionVersion,
    data.status
  );
}

/**
 * 更新主题状态
 */
function updateTopicStatus(db: Database.Database, topicName: string, status: string) {
  db.prepare(`
    UPDATE topic_extraction_metadata SET status = ? WHERE topic_name = ?
  `).run(status, topicName);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 运行提取
const topicName = process.argv[2];
const limitArg = process.argv[3];
const limit = limitArg ? parseInt(limitArg, 10) : undefined;
incrementalExtract(topicName, limit).catch(console.error);
