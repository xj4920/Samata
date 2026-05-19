import Anthropic from '@anthropic-ai/sdk';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { writeWikiPage } from '../services/wiki-compile.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'file_to_wiki',
    description: '将对话中从知识库综合得到的关联洞察写入 Wiki。content 必须严格基于 search_knowledge 返回的结果，每条信息标注来源，严禁混入训练数据。覆盖式更新（非追加）。',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: '页面标题（简洁明确）' },
        category: {
          type: 'string',
          enum: ['entity', 'concept', 'insight', 'comparison'],
          description: '分类：entity=实体综合、concept=概念定义、insight=分析洞察、comparison=对比分析',
        },
        content: { type: 'string', description: 'Markdown 内容，包含关联说明和来源引用' },
        related_pages: {
          type: 'array',
          items: { type: 'string' },
          description: '关联的已有 wiki 页面名（可选）',
        },
      },
      required: ['title', 'category', 'content'],
    },
  },
];

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  if (name === 'file_to_wiki') {
    const agent = getCurrentAgent();
    if (!agent) {
      return JSON.stringify({ success: false, error: '无法确定当前 Agent' });
    }

    const { title, category, content, related_pages } = input as {
      title: string;
      category: 'entity' | 'concept' | 'insight' | 'comparison';
      content: string;
      related_pages?: string[];
    };

    if (!title || !category || !content) {
      return JSON.stringify({ success: false, error: '缺少必要参数: title, category, content' });
    }

    const result = writeWikiPage(agent.id, title, category, content, related_pages);
    return JSON.stringify(result);
  }

  return null;
}
