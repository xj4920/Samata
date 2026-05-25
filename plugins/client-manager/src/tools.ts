import type { ToolDefinition } from '@samata-platform/plugin-sdk';

export const toolDefinitions: ToolDefinition[] = [
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
    description: '查看某个客户的详细信息，包含客户报价条款字段：commission、commission_cost、net_comm、long_financing_spread、short_financing、index_hedging、is_ft，以及 pricing_range（同一管理人下多产品报价的 min/max 范围与来源产品列表）。当用户问"某客户的报价/commission/点差/financing/费率/返佣"时使用本工具，不要用 query_pricing_quote（后者是产品利率矩阵）。',
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
          description: '要更新的字段',
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
    name: 'delete_client',
    description: '删除客户（仅管理员）。必须二次确认：第一次调用 dry_run=true（默认），返回即将删除的客户摘要给用户审阅；用户明确确认后再以 dry_run=false 调用实际删除。严禁在未与用户确认的情况下直接传 dry_run=false。',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
        dry_run: { type: 'boolean', description: '是否为预览模式。默认 true（仅预览，不删除），用户确认后设为 false 实际删除' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'import_pricing_schedule',
    description: '从客户报价Excel文件导入报价信息到客户属性。默认为预览模式（dry_run=true），仅展示匹配结果不写入数据库；用户确认后设置dry_run=false执行实际导入。',
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
