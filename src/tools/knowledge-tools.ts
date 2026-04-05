import Anthropic from '@anthropic-ai/sdk';
import type { SearchKnowledgeInput, AddKnowledgeInput, UpdateKnowledgeInput, AssignKnowledgeAgentInput, UnassignKnowledgeAgentInput } from '../llm/tool-types.js';
import { isSystemAdmin } from '../auth/rbac.js';
import { getDb } from '../db/connection.js';
import { fetchKnowledge, addKnowledge, updateKnowledgeById, deleteKnowledge, assignKnowledgeToAgent, unassignKnowledgeFromAgent, getKnowledgeAgents } from '../commands/knowledge.js';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'search_knowledge',
    description: '搜索知识库中的FAQ。支持多关键词搜索（空格分隔），会自动拆分并匹配。建议传入2-3个核心关键词而非完整句子。例如：用户问"专线怎么申请"→传入"专线 申请"；问"北向极速开通流程"→传入"北向 极速 开通"。如果首次搜索无结果，尝试减少关键词或换用同义词重试。',
    input_schema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: '搜索关键词（多个关键词用空格分隔，匹配任一即返回，全部匹配排在前面）' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'add_knowledge',
    description: '向知识库新增一条FAQ条目，并自动关联到当前 Agent。需提供问题和答案，标签和相关人员可选。',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: '问题' },
        answer: { type: 'string', description: '答案' },
        tags: { type: 'string', description: '标签（可选，逗号分隔）' },
        related_users: { type: 'string', description: '相关人员（可选，逗号分隔）' },
      },
      required: ['question', 'answer'],
    },
  },
  {
    name: 'update_knowledge',
    description: '更新知识库中已有的FAQ条目（需当前 Agent 管理员权限，且条目须属于当前 Agent）。需先通过 search_knowledge 搜索找到目标QA，再用ID前缀进行更新。支持修改问题、答案、标签等字段。',
    input_schema: {
      type: 'object' as const,
      properties: {
        id_prefix: { type: 'string', description: 'FAQ的ID或ID前缀（通过 search_knowledge 获取）' },
        fields: {
          type: 'object' as const,
          description: '要更新的字段，如 { "question": "新问题", "answer": "新答案", "tags": "标签1,标签2" }',
          properties: {
            question: { type: 'string', description: '问题' },
            answer: { type: 'string', description: '答案' },
            tags: { type: 'string', description: '标签（逗号分隔）' },
            related_users: { type: 'string', description: '相关人员（逗号分隔）' },
          },
        },
      },
      required: ['id_prefix', 'fields'],
    },
  },
  {
    name: 'delete_knowledge',
    description: '删除知识库中的FAQ条目（需当前 Agent 管理员权限，且条目须属于当前 Agent）。需先通过 search_knowledge 搜索找到目标QA，再用ID前缀进行删除。',
    input_schema: {
      type: 'object' as const,
      properties: {
        id_prefix: { type: 'string', description: 'FAQ的ID或ID前缀（通过 search_knowledge 获取）' },
      },
      required: ['id_prefix'],
    },
  },
  {
    name: 'assign_knowledge_agent',
    description: '将知识条目关联到指定 Agent，使该 Agent 可通过 search_knowledge 搜索到该条目（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        knowledge_id: { type: 'string', description: '知识条目 ID 或 ID 前缀（通过 search_knowledge 获取）' },
        agent_name: { type: 'string', description: 'Agent 名称（如 otcclaw、doctor、tutor）' },
      },
      required: ['knowledge_id', 'agent_name'],
    },
  },
  {
    name: 'unassign_knowledge_agent',
    description: '解除知识条目与指定 Agent 的关联（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        knowledge_id: { type: 'string', description: '知识条目 ID 或 ID 前缀' },
        agent_name: { type: 'string', description: 'Agent 名称' },
      },
      required: ['knowledge_id', 'agent_name'],
    },
  },
  {
    name: 'get_knowledge_agents',
    description: '查询某条知识条目关联了哪些 Agent',
    input_schema: {
      type: 'object' as const,
      properties: {
        knowledge_id: { type: 'string', description: '知识条目 ID 或 ID 前缀' },
      },
      required: ['knowledge_id'],
    },
  },
];

function handleSearchKnowledge(input: SearchKnowledgeInput): string {
  const agentId = getCurrentAgent()?.id;
  const rows = fetchKnowledge(input.keyword, agentId);
  if (rows.length === 0) return JSON.stringify({ message: '未找到相关FAQ，建议换用更短或不同的关键词重试' });
  return JSON.stringify(rows.map(r => ({
    id: r.id.slice(0, 8),
    question: r.question,
    answer: r.answer,
    tags: r.tags,
    relevance: (r as any).relevance,
  })));
}

function handleAddKnowledge(input: AddKnowledgeInput): string {
  const agentId = getCurrentAgent()?.id ?? '';
  return JSON.stringify(addKnowledge(input, agentId));
}

function handleUpdateKnowledge(input: UpdateKnowledgeInput): string {
  const agentId = getCurrentAgent()?.id ?? '';
  const db = getDb();
  const rows = db.prepare('SELECT id FROM knowledge WHERE id LIKE ?').all(`${input.id_prefix}%`) as { id: string }[];
  if (rows.length === 0) return JSON.stringify({ success: false, error: `未找到FAQ: ${input.id_prefix}` });
  if (rows.length > 1) return JSON.stringify({ success: false, error: '匹配到多条，请提供���长的ID前缀' });
  return JSON.stringify(updateKnowledgeById(input.id_prefix, input.fields, agentId));
}

function handleDeleteKnowledge(input: { id_prefix: string }): string {
  const agentId = getCurrentAgent()?.id ?? '';
  return JSON.stringify(deleteKnowledge(input.id_prefix, agentId));
}

function handleAssignKnowledgeAgent(input: AssignKnowledgeAgentInput): string {
  if (!isSystemAdmin()) return JSON.stringify({ error: '权限不足：需要系统管理员权限' });
  return JSON.stringify(assignKnowledgeToAgent(input.knowledge_id, input.agent_name));
}

function handleUnassignKnowledgeAgent(input: { knowledge_id: string; agent_name: string }): string {
  if (!isSystemAdmin()) return JSON.stringify({ error: '权限不足：需要系统管理员权限' });
  return JSON.stringify(unassignKnowledgeFromAgent(input.knowledge_id, input.agent_name));
}

function handleGetKnowledgeAgents(input: { knowledge_id: string }): string {
  return JSON.stringify(getKnowledgeAgents(input.knowledge_id));
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'search_knowledge': return handleSearchKnowledge(input);
    case 'add_knowledge': return handleAddKnowledge(input);
    case 'update_knowledge': return handleUpdateKnowledge(input);
    case 'delete_knowledge': return handleDeleteKnowledge(input);
    case 'assign_knowledge_agent': return handleAssignKnowledgeAgent(input);
    case 'unassign_knowledge_agent': return handleUnassignKnowledgeAgent(input);
    case 'get_knowledge_agents': return handleGetKnowledgeAgents(input);
    default: return null;
  }
}
