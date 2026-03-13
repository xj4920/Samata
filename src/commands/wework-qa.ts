import { fetchWeworkMessages, WeworkMessage } from './wework.js';
import { log } from '../utils/logger.js';
import { getProvider, getModelName } from '../llm/provider.js';
import { parseLLMJsonArray } from '../utils/json-repair.js';

export interface QAPair {
  question: string;
  answer: string;
  tags?: string[];
  time: string;
  session: string;
  questioner: string;
  answerer: string;
  context?: string;
}

/**
 * 从企微聊天记录中提取有价值的 Q&A 对
 * @param topics 主题关键词列表（用于过滤相关消息，支持多个关键词）
 * @param people 相关人员列表（发送人名称，可选）
 * @param startDate 开始日期 YYYY-MM-DD（可选）
 * @param endDate 结束日期 YYYY-MM-DD（可选）
 * @param session 群聊名称（可选）
 * @param limit 返回 Q&A 对数量上限，默认 10
 * @param verbose 是否显示详细日志，默认 true
 */
export async function extractWeworkQA(params: {
  topics?: string[];
  people?: string[];
  startDate?: string;
  endDate?: string;
  session?: string;
  limit?: number;
  verbose?: boolean;
}): Promise<QAPair[]> {
  const limit = params.limit ?? 10;
  const verbose = params.verbose ?? true;

  // 1. 获取相关消息（支持多关键词）
  let allMessages: WeworkMessage[] = [];
  const messageIds = new Set<string>(); // 用于去重

  if (params.topics && params.topics.length > 0) {
    if (verbose) {
      log.print(`🔍 搜索关键词: ${params.topics.join(', ')}`);
    }

    for (const keyword of params.topics) {
      const messages = await fetchWeworkMessages({
        session: params.session,
        keyword: keyword.trim(),
        limit: 500,
      });

      // 去重合并
      for (const msg of messages) {
        const msgId = `${msg.time}-${msg.sender}-${msg.content}`;
        if (!messageIds.has(msgId)) {
          messageIds.add(msgId);
          allMessages.push(msg);
        }
      }
    }

    if (verbose) {
      log.print(`📊 找到 ${allMessages.length} 条相关消息`);
    }
  } else {
    // 没有关键词，获取所有消息
    allMessages = await fetchWeworkMessages({
      session: params.session,
      limit: 500,
    });

    if (verbose) {
      log.print(`📊 找到 ${allMessages.length} 条消息`);
    }
  }

  if (allMessages.length === 0) {
    if (verbose) {
      log.print('❌ 未找到匹配的消息');
    }
    return [];
  }

  // 2. 按时间和人员过滤
  let filtered = allMessages;

  if (params.startDate) {
    filtered = filtered.filter(m => m.time >= params.startDate!);
    if (verbose) {
      log.print(`📅 时间过滤（>= ${params.startDate}）: ${filtered.length} 条`);
    }
  }

  if (params.endDate) {
    filtered = filtered.filter(m => m.time <= params.endDate! + ' 23:59:59');
    if (verbose) {
      log.print(`📅 时间过滤（<= ${params.endDate}）: ${filtered.length} 条`);
    }
  }

  if (params.people && params.people.length > 0) {
    filtered = filtered.filter(m =>
      params.people!.some(p => m.sender.includes(p))
    );
    if (verbose) {
      log.print(`👥 人员过滤（${params.people.join(', ')}）: ${filtered.length} 条`);
    }
  }

  if (filtered.length === 0) {
    if (verbose) {
      log.print('❌ 过滤后无消息');
    }
    return [];
  }

  if (verbose) {
    log.print(`\n🤖 使用 LLM 提取 Q&A 对（最多 ${limit} 个）...\n`);
  }

  // 3. 使用 LLM 提取 Q&A 对
  const topicStr = params.topics?.join('、');
  const qaPairs = await extractQAWithLLM(filtered, topicStr, limit);

  return qaPairs;
}

/**
 * 使用 LLM 从消息列表中提取 Q&A 对
 */
async function extractQAWithLLM(
  messages: WeworkMessage[],
  topic: string | undefined,
  limit: number
): Promise<QAPair[]> {
  // 构建对话上下文
  const conversationText = messages
    .map(m => `[${m.time}] ${m.sender}: ${m.content}`)
    .join('\n');

  const topicHint = topic ? `\n提取主题：${topic}\n请重点关注与该主题相关的问答。` : '';
  const prompt = `从以下企微群聊记录中提取有价值的 Q&A 对。${topicHint}

要求：
- 提取真实的业务问答（技术问题、流程咨询、故障排查等）
- 问题和答案应泛化为通用知识，去除客户特定信息（具体 IP、账号、公司名等）
- 跳过寒暄、确认、会议安排等无知识价值的内容
- 最多提取 ${limit} 个最有价值的 Q&A 对

聊天记录：
${conversationText}

以 JSON 数组返回，每个元素包含：
- question: 问题（泛化为通用问题）
- answer: 答案（综合多条消息，简明扼要，300 字以内）
- tags: 标签数组（1-3 个）
- time: 问题时间（YYYY-MM-DD HH:MM:SS）
- questioner: 提问人
- answerer: 回答人
- context: 业务场景说明

只返回 JSON 数组，不要其他内容。无符合标准的 Q&A 则返回 []。`;

  try {
    const provider = getProvider();
    const response = await provider.createMessage({
      model: getModelName(),
      max_tokens: 16000,
      system: '你是一个业务知识提取专家。请直接返回 JSON 结果，不要使用 markdown 代码块包裹，不要使用 <think> 标签或其他思考过程标记。',
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

    // 补充 session 信息
    return qaPairs.map(qa => {
      const msg = messages.find(m => m.time === qa.time);
      return {
        ...qa,
        session: msg?.session || messages[0]?.session || 'unknown',
      };
    });
  } catch (err: any) {
    log.print(`LLM 提取 Q&A 失败: ${err.message}`);
    return [];
  }
}

/**
 * CLI 命令处理
 * 用法: /wework-qa topics=关键词1,关键词2 people=人员1,人员2 start=2024-01-01 end=2024-12-31 session=群名 limit=10
 */
export async function weworkQA(args: string): Promise<void> {
  const params = parseArgs(args);

  try {
    const topics = params.topics ? params.topics.split(',').map(t => t.trim()) : undefined;
    const people = params.people ? params.people.split(',').map(p => p.trim()) : undefined;

    const qaPairs = await extractWeworkQA({
      topics,
      people,
      startDate: params.start,
      endDate: params.end,
      session: params.session,
      limit: params.limit ? Number(params.limit) : undefined,
      verbose: true,
    });

    if (qaPairs.length === 0) {
      log.print('\n❌ 未提取到有价值的 Q&A 对');
      return;
    }

    log.print(`\n✅ 提取到 ${qaPairs.length} 个 Q&A 对：\n`);

    for (let i = 0; i < qaPairs.length; i++) {
      const qa = qaPairs[i];
      log.print(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      log.print(`Q&A #${i + 1}`);
      log.print(`时间: ${qa.time}`);
      log.print(`群组: ${qa.session}`);
      log.print(`提问人: ${qa.questioner}`);
      log.print(`回答人: ${qa.answerer}`);
      if (qa.tags && qa.tags.length > 0) {
        log.print(`标签: ${qa.tags.join(', ')}`);
      }
      if (qa.context) {
        log.print(`上下文: ${qa.context}`);
      }
      log.print(`\n问题:\n${qa.question}`);
      log.print(`\n答案:\n${qa.answer}`);
    }

    log.print(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  } catch (err: any) {
    log.print(`提取 Q&A 失败: ${err.message}`);
  }
}

function parseArgs(args: string): Record<string, string> {
  const params: Record<string, string> = {};
  // 支持 key=value 和 key="value with spaces"
  const re = /(\w+)=(?:"([^"]+)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    params[m[1].toLowerCase()] = m[2] ?? m[3];
  }
  return params;
}
