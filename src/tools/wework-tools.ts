import Anthropic from '@anthropic-ai/sdk';
import type { ExtractWeworkQAInput } from '../llm/tool-types.js';
import type { ToolContext } from '../llm/agents/config.js';
import { extractWeworkQA } from '../commands/wework-qa.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'extract_wework_qa',
    description: '从企业微信聊天记录中提取有价值的问答对（Q&A pairs）。使用 LLM 智能识别问题和答案，适合用于知识库构建、FAQ 整理等场景。支持多关键词搜索。',
    input_schema: {
      type: 'object' as const,
      properties: {
        topics: { type: 'array', items: { type: 'string' }, description: '主题关键词列表，用于过滤相关消息。应拆分为多个短关键词，如["期货手数","流速控制","限额"]' },
        people: { type: 'array', items: { type: 'string' }, description: '相关人员名称列表，用于过滤发送人（可选）' },
        start_date: { type: 'string', description: '开始日期，格式 YYYY-MM-DD（可选）' },
        end_date: { type: 'string', description: '结束日期，格式 YYYY-MM-DD（可选）' },
        session: { type: 'string', description: '群聊名称，模糊匹配（可选）' },
        limit: { type: 'number', description: '返回 Q&A 对数量上限，默认 10' },
      },
      required: [],
    },
  },
];

async function handleExtractWeworkQA(input: ExtractWeworkQAInput): Promise<string> {
  try {
    const qaPairs = await extractWeworkQA({
      topics: input.topics,
      people: input.people,
      startDate: input.start_date,
      endDate: input.end_date,
      session: input.session,
      limit: input.limit,
      verbose: false,
    });
    if (qaPairs.length === 0) {
      return JSON.stringify({ message: '未提取到有价值的 Q&A 对' });
    }
    return JSON.stringify(qaPairs);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'extract_wework_qa': return handleExtractWeworkQA(input);
    default: return null;
  }
}
