import { fetchWeworkMessages } from './wework.js';
import { log } from '../utils/logger.js';
import { getProvider, getModelName } from '../llm/provider.js';

/**
 * 从企微聊天记录中grep多个关键词，并用LLM分析特定信息
 */
export async function grepAndAnalyze(params: {
  keywords: string[];
  analysisPrompt: string;
  limit?: number;
}): Promise<string> {
  const { keywords, analysisPrompt, limit = 500 } = params;

  // 1. 获取包含所有关键词的消息
  log.print(`正在搜索包含关键词的聊天记录: ${keywords.join(', ')}...`);
  
  const allMessages = await fetchWeworkMessages({ limit: 2000 });
  
  // 过滤包含所有关键词的消息（不区分大小写）
  const filtered = allMessages.filter(msg => {
    const content = msg.content.toLowerCase();
    return keywords.every(kw => content.includes(kw.toLowerCase()));
  });

  if (filtered.length === 0) {
    return '未找到包含所有关键词的聊天记录';
  }

  log.print(`找到 ${filtered.length} 条相关消息，正在用LLM分析...`);

  // 2. 构建对话上下文
  const conversationText = filtered
    .slice(0, limit)
    .map(m => `[${m.time}] ${m.session} | ${m.sender}: ${m.content}`)
    .join('\n');

  // 3. 使用LLM分析
  const prompt = `${analysisPrompt}

聊天记录：
${conversationText}

请详细分析并提取相关信息。`;

  try {
    const provider = getProvider();
    const response = await provider.createMessage({
      model: getModelName(),
      max_tokens: 4000,
      system: '',
      tools: [],
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      return '分析失败：LLM返回格式错误';
    }

    return content.text;
  } catch (err: any) {
    log.print(`LLM分析失败: ${err.message}`);
    throw err;
  }
}

/**
 * CLI命令：grep企微聊天记录并分析
 * 用法: /wework-grep keywords="fix,股指期货" prompt="分析限额信息"
 */
export async function weworkGrep(args: string): Promise<void> {
  const params = parseArgs(args);
  
  if (!params.keywords) {
    log.print('用法: /wework-grep keywords="关键词1,关键词2" prompt="分析提示"');
    return;
  }

  const keywords = params.keywords.split(',').map(k => k.trim());
  const analysisPrompt = params.prompt || '请分析以下聊天记录中的关键信息';

  try {
    const result = await grepAndAnalyze({
      keywords,
      analysisPrompt,
      limit: params.limit ? Number(params.limit) : undefined,
    });

    log.print('\n分析结果：\n');
    log.print(result);
  } catch (err: any) {
    log.print(`分析失败: ${err.message}`);
  }
}

function parseArgs(args: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)=["']?([^"'\s]+(?:\s+[^"'\s]+)*)["']?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    params[m[1].toLowerCase()] = m[2];
  }
  return params;
}
