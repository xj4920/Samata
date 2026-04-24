import Anthropic from '@anthropic-ai/sdk';
import type { SearchKnowledgeInput, AddKnowledgeInput, UpdateKnowledgeInput, AssignKnowledgeAgentInput, UnassignKnowledgeAgentInput, ListKnowledgeRecentInput } from '../llm/tool-types.js';
import { isSystemAdmin, getCurrentUser } from '../auth/rbac.js';
import { getDb } from '../db/connection.js';
import { fetchKnowledge, fetchKnowledgeByUpdatedTime, addKnowledge, updateKnowledgeById, deleteKnowledge, assignKnowledgeToAgent, unassignKnowledgeFromAgent, getKnowledgeAgents } from '../commands/knowledge.js';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { recordKnowledge as recordKnowledgeTelemetry } from '../telemetry/emitter.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'search_knowledge',
    description: '同时搜索 FAQ 与文档知识，返回结构化的双分组结果：`{ faq: [...], documents: [...] }`。关键词用空格分隔，匹配任一即返回，匹配更多的条目排在前面。中文短语可直接传入（如"雪球产品对冲"），也可拆成 2-4 字短词以提高 FAQ 命中率。如果首次搜索无结果，尝试减少关键词或换用同义词。',
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
  {
    name: 'list_knowledge_recent',
    description: '按更新时间查询知识库条目。可指定起止时间范围，返回该时间段内更新过的FAQ列表。时间格式为 ISO 日期或日期时间（如 "2026-04-01" 或 "2026-04-13T12:00:00"）。不传参数则返回最近更新的条目。',
    input_schema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: '起始时间（含），ISO 日期或日期时间' },
        until: { type: 'string', description: '截止时间（含），ISO 日期或日期时间' },
        limit: { type: 'number', description: '返回条数上限，默认20，最大50' },
      },
      required: [],
    },
  },
];

const MAX_SEARCH_RESULT_CHARS = 3000;
const MAX_SNIPPET_LEN = 500;

/** 根据关键词位置提取 answer 中最相关的片段，而不是盲取开头 */
function extractRelevantSnippet(answer: string, keyword: string): string {
  if (answer.length <= MAX_SNIPPET_LEN) return answer;

  // 优先用最长（最具体）的关键词定位，避免被短通用词（如"规则"）拉到开头
  const keywords = keyword.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  let bestPos = -1;

  for (const kw of keywords) {
    const pos = answer.indexOf(kw);
    if (pos !== -1) {
      bestPos = pos;
      break;
    }
  }

  if (bestPos === -1) return answer.slice(0, MAX_SNIPPET_LEN) + '...';

  // 向前找最近的 markdown 标题或段落边界作为片段起点
  let start = bestPos;
  const searchBack = answer.slice(Math.max(0, bestPos - 200), bestPos);
  const headingMatch = searchBack.lastIndexOf('\n#');
  if (headingMatch !== -1) {
    start = Math.max(0, bestPos - 200) + headingMatch + 1; // skip the \n
  } else {
    const nlMatch = searchBack.lastIndexOf('\n');
    if (nlMatch !== -1) {
      start = Math.max(0, bestPos - 200) + nlMatch + 1;
    }
  }

  const snippet = answer.slice(start, start + MAX_SNIPPET_LEN);
  const prefix = start > 0 ? '...' : '';
  const suffix = start + MAX_SNIPPET_LEN < answer.length ? '...' : '';
  return prefix + snippet + suffix;
}

function handleSearchKnowledge(input: SearchKnowledgeInput): string {
  const agentId = getCurrentAgent()?.id;
  const { faq, documents } = fetchKnowledge(input.keyword, agentId);

  // Record knowledge search hit for telemetry
  const totalHits = faq.length + documents.length;
  recordKnowledgeTelemetry(getCurrentUser()?.id ?? 'unknown', {
    keyword: input.keyword,
    hits: totalHits,
    agent_id: agentId ?? 'unknown',
  });

  if (faq.length === 0 && documents.length === 0) {
    return JSON.stringify({ message: '未找到相关结果，建议换用更短或不同的关键词重试' });
  }

  const faqOut: any[] = [];
  const docOut: any[] = [];
  let totalLen = 0;

  for (const item of faq) {
    const shrunkAnswer = extractRelevantSnippet(item.answer, input.keyword);
    const entry = {
      id: item.id.slice(0, 8),
      question: item.question,
      answer: shrunkAnswer,
      tags: item.tags,
      relevance: item.relevance,
    };
    const size = JSON.stringify(entry).length;
    if (totalLen + size > MAX_SEARCH_RESULT_CHARS && faqOut.length > 0) break;
    faqOut.push(entry);
    totalLen += size;
  }

  for (const doc of documents) {
    const entry = {
      document_id: doc.document_id.slice(0, 8),
      title: doc.title,
      snippet: doc.snippet,
      tags: doc.tags,
      relevance: doc.relevance,
    };
    const size = JSON.stringify(entry).length;
    if (totalLen + size > MAX_SEARCH_RESULT_CHARS && docOut.length > 0) break;
    docOut.push(entry);
    totalLen += size;
  }

  return JSON.stringify({ faq: faqOut, documents: docOut });
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

function handleListKnowledgeRecent(input: ListKnowledgeRecentInput): string {
  const agentId = getCurrentAgent()?.id;
  const rows = fetchKnowledgeByUpdatedTime(input.since, input.until, agentId, input.limit);
  if (rows.length === 0) return JSON.stringify({ message: '该时间范围内没有更新的FAQ' });
  return JSON.stringify(rows.map(r => ({
    id: r.id.slice(0, 8),
    question: r.question,
    answer: r.answer,
    tags: r.tags,
    updated_at: r.updated_at,
  })));
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
    case 'list_knowledge_recent': return handleListKnowledgeRecent(input);
    default: return null;
  }
}
