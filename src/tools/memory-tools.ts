import Anthropic from '@anthropic-ai/sdk';
import type { SaveMemoryInput, SearchMemoryInput, DeleteMemoryInput, UpdateMemoryInput } from '../llm/tool-types.js';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { saveMemory, searchMemory, deleteMemory, updateMemory, getMemoryByIdPrefix } from '../llm/agents/memory.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'save_memory',
    description: '保存一条记忆/事实到持久化存储，跨会话可用。scope=global 仅系统管理员可用，scope=agent 需当前 Agent 管理员权限。',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: '要记住的事实或信息（最大500字符）' },
        scope: { type: 'string', description: "'global'（全局，仅系统管理员可保存）或 'agent'（仅当前 Agent 可见，需 Agent 管理员权限）。默认 agent" },
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
    description: '修改一条已保存的记忆内容或分类。全局记忆仅系统管理员可修改，Agent 记忆需对应 Agent 管理员权限。',
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
    description: '删除一条已保存的记忆。全局记忆仅系统管理员可删除，Agent 记忆需对应 Agent 管理员权限。',
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
  const currentAgentId = getCurrentAgent()?.id;
  const scope = (input.scope as 'global' | 'agent') ?? 'agent';

  const result = saveMemory({
    content: input.content,
    scope,
    agentId: scope === 'agent' ? currentAgentId ?? undefined : undefined,
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
  const row = getMemoryByIdPrefix(input.id);
  if (!row) return JSON.stringify({ error: `未找到记忆: ${input.id}` });

  return JSON.stringify(updateMemory(input.id, { content: input.content, category: input.category }));
}

function handleDeleteMemory(input: DeleteMemoryInput): string {
  const row = getMemoryByIdPrefix(input.id);
  if (!row) return JSON.stringify({ error: `未找到记忆: ${input.id}` });

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
