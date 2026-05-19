import Anthropic from '@anthropic-ai/sdk';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { writeWikiPage, compileAllDocuments, recompileDocument } from '../services/wiki-compile.js';
import { isAgentAdmin } from '../auth/rbac.js';

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
  {
    name: 'compile_wiki',
    description: '对当前 Agent 的所有已导入文档执行 Wiki 编译（回溯构建知识网络）。跳过 content_hash 未变的文档。需管理员权限。',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'recompile_document',
    description: '在 document 内容被 edit_file 修改后，purge 旧 wiki 片段并重新编译该文档。需提供文档 ID 前缀（list_documents 获取）。',
    input_schema: {
      type: 'object' as const,
      properties: {
        id_prefix: { type: 'string', description: '文档 ID 或 8 位前缀' },
      },
      required: ['id_prefix'],
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

  if (name === 'compile_wiki') {
    const agent = getCurrentAgent();
    if (!agent) {
      return JSON.stringify({ success: false, error: '无法确定当前 Agent' });
    }
    if (!isAgentAdmin(agent.id)) {
      return JSON.stringify({ success: false, error: '权限不足：需要 Agent 管理员权限' });
    }

    const result = await compileAllDocuments(agent.id);
    return JSON.stringify({ success: true, ...result });
  }

  if (name === 'recompile_document') {
    const agent = getCurrentAgent();
    if (!agent) {
      return JSON.stringify({ success: false, error: '无法确定当前 Agent' });
    }
    if (!isAgentAdmin(agent.id)) {
      return JSON.stringify({ success: false, error: '权限不足：需要 Agent 管理员权限' });
    }
    const { id_prefix } = input as { id_prefix?: string };
    if (!id_prefix?.trim()) {
      return JSON.stringify({ success: false, error: '缺少 id_prefix' });
    }
    const ok = await recompileDocument(agent.id, id_prefix.trim());
    return JSON.stringify({ success: ok, message: ok ? 'wiki 已重新编译' : '编译失败，请检查文档是否存在' });
  }

  return null;
}
