import Anthropic from '@anthropic-ai/sdk';
import type { SaveMemoryInput, SearchMemoryInput, DeleteMemoryInput, UpdateMemoryInput } from '../llm/tool-types.js';
import { isAdmin } from '../auth/rbac.js';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { saveMemory, searchMemory, deleteMemory, updateMemory } from '../llm/agents/memory.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'save_memory',
    description: '保存一条记忆/事实到持久化存储，跨会话可用。当对话中出现重要事实、用户偏好、关键信息时主动调用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: '要记住的事实或信息（最大500字符）' },
        scope: { type: 'string', description: "'global'（全局，所有 Agent 可见）或 'agent'（仅当前 Agent 可见）。默认 global" },
        category: { type: 'string', description: "可选分类: 'fact' | 'preference' | 'rule' | 'context'" },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_memory',
    description: '搜索已保存的记忆/事实',
    input_schema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'update_memory',
    description: '修改一条已保存的记忆内容或分类（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '记忆 ID 或 ID 前缀' },
        content: { type: 'string', description: '新的记忆内容（最大500字符）' },
        category: { type: 'string', description: "新的分类: 'fact' | 'preference' | 'rule' | 'context'" },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_memory',
    description: '删除一条已保存的记忆（仅 admin 可用）。需要提供记忆 ID 前缀。',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '要删除的记忆 ID（前缀匹配）' },
      },
      required: ['id'],
    },
  },
];

function handleSaveMemory(input: SaveMemoryInput): string {
  if (!isAdmin()) return JSON.stringify({ error: '仅管理员可保存记忆' });
  const currentAgentId = getCurrentAgent()?.id;
  const result = saveMemory({
    content: input.content,
    scope: (input.scope as 'global' | 'agent') ?? 'global',
    agentId: input.scope === 'agent' ? currentAgentId ?? undefined : undefined,
    category: input.category,
    source: 'manual',
  });
  return JSON.stringify(result);
}

function handleSearchMemory(input: SearchMemoryInput): string {
  const currentAgentId = getCurrentAgent()?.id;
  const items = searchMemory(input.keyword, currentAgentId ?? undefined);
  return JSON.stringify(items);
}

function handleUpdateMemory(input: UpdateMemoryInput): string {
  if (!isAdmin()) return JSON.stringify({ error: '仅管理员可修改记忆' });
  return JSON.stringify(updateMemory(input.id, { content: input.content, category: input.category }));
}

function handleDeleteMemory(input: DeleteMemoryInput): string {
  if (!isAdmin()) return JSON.stringify({ error: '仅管理员可删除记忆' });
  return JSON.stringify(deleteMemory(input.id));
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'save_memory': return handleSaveMemory(input);
    case 'search_memory': return handleSearchMemory(input);
    case 'update_memory': return handleUpdateMemory(input);
    case 'delete_memory': return handleDeleteMemory(input);
    default: return null;
  }
}
