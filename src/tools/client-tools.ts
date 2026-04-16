import Anthropic from '@anthropic-ai/sdk';
import type { QueryClientsInput, ViewClientInput, GetClientHistoryInput, AdvanceClientInput, RollbackClientInput, ImportPricingScheduleInput } from '../llm/tool-types.js';
import { isAgentAdmin } from '../auth/rbac.js';
import { getCurrentAgent } from '../llm/agents/config.js';
import { fetchClients, fetchClient, fetchHistory, createClient, updateClient, advanceClient, rollbackClient } from '../commands/client.js';
import { fetchLatestNotionals } from '../commands/trade.js';
import { STATE_LABELS, STATE_PRIORITY, classifyClient } from '../models/client.js';
import type { ToolContext } from '../llm/agents/config.js';
import { importPricingSchedule } from '../commands/client.js';

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
    description: '更新客户信息（仅管理员）。支持更新报价字段：long_financing_spread, short_financing, commission, commission_cost, net_comm, index_hedging, is_ft',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
        fields: {
          type: 'object' as const,
          description: '要更新的字段，如 { "wework_group": "xx", "contact": "xx", "long_financing_spread": "0.01", "commission": "0.00016", "is_ft": "1" }。报价字段：long_financing_spread, short_financing, commission, commission_cost, net_comm, index_hedging(0或1), is_ft(0或1，是否极速客户)',
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
  {
    name: 'import_pricing_schedule',
    description: '从客户报价Excel文件导入报价信息到客户属性。默认为预览模式（dry_run=true），仅展示匹配结果不写入数据库；用户确认后设置dry_run=false执行实际导入。解析xlsx中的Pricing Schedule，将Long Financing Spread、Short Financing等字段设置到对应客户。Commission/CommissionCost/NetComm单位为bp(0.0001)，导入时自动转换为小数。仅极速客户(is_ft=1)会根据Short Financing是否为空自动分类为多空客户或中性客户。未匹配客户会推荐最相似的前3个。',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: '报价Excel文件路径（支持 ~/ 相对路径）' },
        dry_run: { type: 'boolean', description: '是否为预览模式。默认true（仅预览不写入），用户确认后设为false执行实际导入' },
      },
      required: ['file_path'],
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

  return JSON.stringify(rows.map(c => {
    const category = classifyClient(c.is_ft === 1, c.short_financing);
    return {
      id: c.id.slice(0, 8),
      name: c.name,
      wework_group: c.wework_group,
      requirements: c.requirements,
      sales: c.sales,
      contact: c.contact,
      state: STATE_LABELS[c.state],
      notional_t: notionals.get(c.name.toLowerCase()) ?? null,
      tags: c.tags,
      category,
      notes: c.notes,
      long_financing_spread: c.long_financing_spread,
      short_financing: c.short_financing,
      commission: c.commission,
      commission_cost: c.commission_cost,
      net_comm: c.net_comm,
      index_hedging: c.index_hedging === 1 ? true : c.index_hedging === 0 ? false : null,
      is_ft: c.is_ft === 1,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }));
}

function handleViewClient(input: ViewClientInput): string {
  const client = fetchClient(input.name_or_id);
  if (!client) return JSON.stringify({ error: `未找到客户: ${input.name_or_id}` });
  const category = classifyClient(client.is_ft === 1, client.short_financing);
  return JSON.stringify({
    id: client.id,
    name: client.name,
    wework_group: client.wework_group,
    requirements: client.requirements,
    sales: client.sales,
    contact: client.contact,
    state: STATE_LABELS[client.state],
    tags: client.tags,
    category,
    notes: client.notes,
    long_financing_spread: client.long_financing_spread,
    short_financing: client.short_financing,
    commission: client.commission,
    commission_cost: client.commission_cost,
    net_comm: client.net_comm,
    index_hedging: client.index_hedging === 1 ? true : client.index_hedging === 0 ? false : null,
    is_ft: client.is_ft === 1,
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
  if (!isAgentAdmin(getCurrentAgent()?.id ?? '')) return JSON.stringify({ error: '权限不足：需要 Agent 管理员权限' });
  return JSON.stringify(createClient(input));
}

function handleUpdateClient(input: { name_or_id: string; fields: Record<string, string> }): string {
  if (!isAgentAdmin(getCurrentAgent()?.id ?? '')) return JSON.stringify({ error: '权限不足：需要 Agent 管理员权限' });
  return JSON.stringify(updateClient(input.name_or_id, input.fields));
}

function handleAdvanceClient(input: AdvanceClientInput): string {
  if (!isAgentAdmin(getCurrentAgent()?.id ?? '')) return JSON.stringify({ error: '权限不足：需要 Agent 管理员权限' });
  return JSON.stringify(advanceClient(input.name_or_id));
}

function handleRollbackClient(input: { name_or_id: string }): string {
  if (!isAgentAdmin(getCurrentAgent()?.id ?? '')) return JSON.stringify({ error: '权限不足：需要 Agent 管理员权限' });
  return JSON.stringify(rollbackClient(input.name_or_id));
}

function handleImportPricingSchedule(input: ImportPricingScheduleInput): string {
  if (!isAgentAdmin(getCurrentAgent()?.id ?? '')) return JSON.stringify({ error: '权限不足：需要 Agent 管理员权限' });
  return JSON.stringify(importPricingSchedule(input.file_path, input.dry_run ?? true));
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
    case 'import_pricing_schedule': return handleImportPricingSchedule(input);
    default: return null;
  }
}
