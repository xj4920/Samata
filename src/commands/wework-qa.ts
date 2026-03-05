import { fetchWeworkMessages, WeworkMessage } from './wework.js';
import { log } from '../utils/logger.js';
import { getProvider, getModelName } from '../llm/provider.js';

export interface QAPair {
  question: string;
  answer: string;
  time: string;
  session: string;
  questioner: string;
  answerer: string;
  context?: string;
}

/**
 * 从企微聊天记录中提取有价值的 Q&A 对
 * @param topic 主题关键词（用于过滤相关消息）
 * @param people 相关人员列表（发送人名称，可选）
 * @param startDate 开始日期 YYYY-MM-DD（可选）
 * @param endDate 结束日期 YYYY-MM-DD（可选）
 * @param session 群聊名称（可选）
 * @param limit 返回 Q&A 对数量上限，默认 10
 */
export async function extractWeworkQA(params: {
  topic?: string;
  people?: string[];
  startDate?: string;
  endDate?: string;
  session?: string;
  limit?: number;
}): Promise<QAPair[]> {
  const limit = params.limit ?? 10;

  // 1. 获取相关消息
  const messages = await fetchWeworkMessages({
    session: params.session,
    keyword: params.topic,
    limit: 500, // 获取更多消息用于分析
  });

  if (messages.length === 0) {
    return [];
  }

  // 2. 按时间和人员过滤
  let filtered = messages;

  if (params.startDate) {
    filtered = filtered.filter(m => m.time >= params.startDate!);
  }

  if (params.endDate) {
    filtered = filtered.filter(m => m.time <= params.endDate! + ' 23:59:59');
  }

  if (params.people && params.people.length > 0) {
    filtered = filtered.filter(m =>
      params.people!.some(p => m.sender.includes(p))
    );
  }

  if (filtered.length === 0) {
    return [];
  }

  // 3. 使用 LLM 提取 Q&A 对
  const qaPairs = await extractQAWithLLM(filtered, params.topic, limit);

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

  const prompt = `你是一个业务知识提取专家。请从以下企业微信聊天记录中提取**具有普适性和可复用价值**的问答对（Q&A pairs），用于构建业务展业 SOP 知识库。

**必须提取的内容类型：**
1. 技术对接流程和规范（如 API 接入步骤、认证方式、数据格式要求）
2. 常见技术问题及解决方案（如报错处理、配置问题、性能优化）
3. 业务流程和操作规范（如开户流程、交易流程、风控要求）
4. 产品功能说明和使用方法（如功能特性、参数配置、使用限制）
5. 合规和风控要求（如监管规定、风控规则、审批流程）
6. 最佳实践和经验总结（如架构设计、性能调优、问题预防）

**严格排除的内容：**
❌ 特定时间的安排（如"五一后上线"、"下周三测试"）
❌ 特定客户的个性化需求（如"贵司需要定制XX功能"）
❌ 临时性的状态通知（如"系统正在维护"、"已修复"）
❌ 人员协调和会议安排（如"明天开会讨论"）
❌ 缺乏技术或业务细节的简单确认（如"好的"、"收到"）

**提取标准：**
- 问题必须具有代表性，答案必须包含可操作的具体信息
- 答案应该对所有类似场景的客户都有参考价值
- 优先提取包含"如何"、"为什么"、"步骤"、"要求"等关键信息的对话
${topic ? `- 聚焦主题"${topic}"相关的知识` : ''}
- 最多提取 ${limit} 个最有价值的 Q&A 对

聊天记录：
${conversationText}

请以 JSON 数组格式返回，每个元素包含：
- question: 问题内容（提炼为通用问题，去除客户特定信息）
- answer: 答案内容（提炼为通用答案，去除时间和客户特定信息）
- time: 问题提出的时间（格式：YYYY-MM-DD HH:MM:SS）
- questioner: 提问人
- answerer: 回答人
- context: 业务场景说明（如"API对接"、"开户流程"、"风控配置"等）

只返回 JSON 数组，不要其他说明文字。如果没有符合标准的 Q&A，返回空数组 []。`;

  try {
    const provider = getProvider();
    const response = await provider.createMessage({
      model: getModelName(),
      max_tokens: 4000,
      system: '',
      tools: [],
      messages: [{ role: 'user', content: prompt }],
    });

    // 解析 LLM 返回的 JSON
    const content = response.content[0];
    if (content.type !== 'text') {
      return [];
    }

    // 提取 JSON 部分（可能包含在 markdown 代码块中）
    let jsonText = content.text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
    if (jsonMatch) {
      jsonText = jsonMatch[1];
    }

    const qaPairs = JSON.parse(jsonText) as Array<{
      question: string;
      answer: string;
      time: string;
      questioner: string;
      answerer: string;
      context?: string;
    }>;

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
 * 用法: /wework-qa topic=主题 people=人员1,人员2 start=2024-01-01 end=2024-12-31 session=群名 limit=10
 */
export async function weworkQA(args: string): Promise<void> {
  const params = parseArgs(args);

  try {
    const people = params.people ? params.people.split(',') : undefined;

    const qaPairs = await extractWeworkQA({
      topic: params.topic,
      people,
      startDate: params.start,
      endDate: params.end,
      session: params.session,
      limit: params.limit ? Number(params.limit) : undefined,
    });

    if (qaPairs.length === 0) {
      log.print('未提取到有价值的 Q&A 对');
      return;
    }

    log.print(`\n提取到 ${qaPairs.length} 个 Q&A 对：\n`);

    for (let i = 0; i < qaPairs.length; i++) {
      const qa = qaPairs[i];
      log.print(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      log.print(`Q&A #${i + 1}`);
      log.print(`时间: ${qa.time}`);
      log.print(`群组: ${qa.session}`);
      log.print(`提问人: ${qa.questioner}`);
      log.print(`回答人: ${qa.answerer}`);
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
  const re = /(\w+)=([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    params[m[1].toLowerCase()] = m[2];
  }
  return params;
}
