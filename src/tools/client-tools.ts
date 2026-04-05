import Anthropic from '@anthropic-ai/sdk';
import type { QueryClientsInput, ViewClientInput, GetClientHistoryInput, AdvanceClientInput, RollbackClientInput } from '../llm/tool-types.js';
import { isSystemAdmin } from '../auth/rbac.js';
import { fetchClients, fetchClient, fetchHistory, createClient, updateClient, advanceClient, rollbackClient } from '../commands/client.js';
import { fetchLatestNotionals } from '../commands/trade.js';
import { STATE_LABELS, STATE_PRIORITY } from '../models/client.js';
import type { ToolContext } from '../llm/agents/config.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'query_clients',
    description: '查询客户列表。重要：当用户询问特定类型/特征的客户时（如"极速客户"、"VIP客户"、"常速客户"、"某某公司"），必须提取关键词并使用keyword参数进行筛选，不要返回全量数据。支持按状态(state)和关键词(keyword)筛选。',
    input_schema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string', description: '客户状态: initial_contact, requirement_discussion, solution_design, uat, prod' },
        keyword: { type: 'string', description: '关键词模糊搜索（匹配客户名称、企微群名、标签）。示例：用户问"极速客户"→传入"极速"；问"VIP客户"→传入"VIP"；问"常速客户"→传入"常速"；问"某某公司"→传入"某某"。重要：除非用户明确要求"所有客户"或"全部客户"，否则必须提取并传入关键词，不要留空。' },
      },
      required: [],
    },
  },
  {
    name: 'view_client',
    description: '查看某个客户的详细信息',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'get_client_history',
    description: '查看某个客户的操作历史记录',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'add_client',
    description: '添加新客户（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: '客户名称' },
        contact: { type: 'string', description: '联系方式' },
        wework_group: { type: 'string', description: 'WeWork Group' },
        requirements: { type: 'string', description: '需求' },
        sales: { type: 'string', description: '销售' },
        notes: { type: 'string', description: '备注' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_client',
    description: '更新客户信息（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
        fields: {
          type: 'object' as const,
          description: '要更新的字段，如 { "wework_group": "xx", "contact": "xx" }',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['name_or_id', 'fields'],
    },
  },
  {
    name: 'advance_client',
    description: '推进客户到下一个阶段（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'rollback_client',
    description: '回退客户到上一个阶段（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
      },
      required: ['name_or_id'],
    },
  },
];

async function handleQueryClients(input: QueryClientsInput): Promise<string> {
  const rows = fetchClients(input);

  let notionals = new Map<string, number>();
  try {
    notionals = await fetchLatestNotionals();
  } catch (e) {}

  rows.sort((a, b) => {
    const stateDiff = (STATE_PRIORITY[b.state] ?? 0) - (STATE_PRIORITY[a.state] ?? 0);
    if (stateDiff !== 0) return stateDiff;
    return (notionals.get(b.name.toLowerCase()) ?? 0) - (notionals.get(a.name.toLowerCase()) ?? 0);
  });

  return JSON.stringify(rows.map(c => ({
    id: c.id.slice(0, 8),
    name: c.name,
    wework_group: c.wework_group,
    requirements: c.requirements,
    sales: c.sales,
    contact: c.contact,
    state: STATE_LABELS[c.state],
    notional_t: notionals.get(c.name.toLowerCase()) ?? null,
    tags: c.tags,
    notes: c.notes,
    created_at: c.created_at,
    updated_at: c.updated_at,
  })));
}

function handleViewClient(input: ViewClientInput): string {
  const client = fetchClient(input.name_or_id);
  if (!client) return JSON.stringify({ error: `未找到客户: ${input.name_or_id}` });
  return JSON.stringify({
    id: client.id,
    name: client.name,
    wework_group: client.wework_group,
    requirements: client.requirements,
    sales: client.sales,
    contact: client.contact,
    state: STATE_LABELS[client.state],
    tags: client.tags,
    notes: client.notes,
    created_at: client.created_at,
    updated_at: client.updated_at,
  });
}

function handleGetHistory(input: { name_or_id: string }): string {
  const result = fetchHistory(input.name_or_id);
  if (!result) return JSON.stringify({ error: `未找到客户: ${input.name_or_id}` });
  return JSON.stringify(result.events.map(e => ({
    action: e.action,
    payload: e.payload,
    time: e.created_at,
  })));
}

function handleAddClient(input: { name: string; contact?: string; wework_group?: string; requirements?: string; sales?: string; notes?: string }): string {
  if (!isSystemAdmin()) return JSON.stringify({ error: '权限不足：需要系统管理员权限' });
  return JSON.stringify(createClient(input));
}

function handleUpdateClient(input: { name_or_id: string; fields: Record<string, string> }): string {
  if (!isSystemAdmin()) return JSON.stringify({ error: '权限不足：需要系统管理员权限' });
  return JSON.stringify(updateClient(input.name_or_id, input.fields));
}

function handleAdvanceClient(input: AdvanceClientInput): string {
  if (!isSystemAdmin()) return JSON.stringify({ error: '权限不足：需要系统管理员权限' });
  return JSON.stringify(advanceClient(input.name_or_id));
}

function handleRollbackClient(input: { name_or_id: string }): string {
  if (!isSystemAdmin()) return JSON.stringify({ error: '权限不足：需要系统管理员权限' });
  return JSON.stringify(rollbackClient(input.name_or_id));
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'query_clients': return handleQueryClients(input);
    case 'view_client': return handleViewClient(input);
    case 'get_client_history': return handleGetHistory(input);
    case 'add_client': return handleAddClient(input);
    case 'update_client': return handleUpdateClient(input);
    case 'advance_client': return handleAdvanceClient(input);
    case 'rollback_client': return handleRollbackClient(input);
    default: return null;
  }
}
