import type { ToolDefinition } from '@samata/plugin-sdk';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'import_pricing_quote',
    description: '从产品利率报价Excel文件（如FXD_FRN_Daily Update）导入报价数据。默认为预览模式（dry_run=true），仅展示解析结果不写入数据库；用户确认后设置dry_run=false执行实际导入。解析Fixed/Floating x Currency x Tenor利率矩阵，写入pricing_quotes表。同一agent+quote_type+date的记录会被覆盖更新。',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: '报价Excel文件路径（支持 ~/ 相对路径）' },
        quote_type: { type: 'string', description: "报价类型标识，默认从文件名推断（如 'fxd_frn'）" },
        dry_run: { type: 'boolean', description: '是否为预览模式。默认true（仅预览不写入），用户确认后设为false执行实际导入' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'query_pricing_quote',
    description: '仅用于查询产品利率报价矩阵（FXD/FRN 按货币/期限/Fixed/Floating）。支持按报价类型、日期、货币、期限、利率类型筛选。不指定日期则返回最新报价。示例：query_pricing_quote(currency="USD", tenor="3M", rate_type="Fixed") 查询USD 3M固定利率。注意：查询具体客户的 commission/financing 等条款报价（如"鸣石的报价"）请使用 view_client，不要用本工具。',
    input_schema: {
      type: 'object' as const,
      properties: {
        quote_type: { type: 'string', description: "报价类型，默认 'fxd_frn'" },
        date: { type: 'string', description: '报价日期，格式 YYYY-MM-DD（不传则返回最新）' },
        currency: { type: 'string', description: '货币，如 USD、HKD、CNH' },
        tenor: { type: 'string', description: '期限，如 1M、2M、3M、6M' },
        rate_type: { type: 'string', description: '利率类型：Fixed 或 Floating' },
      },
      required: [],
    },
  },
  {
    name: 'list_pricing_quote_dates',
    description: '列出已导入的报价日期列表（按日期倒序），用于了解有哪些历史报价可查。',
    input_schema: {
      type: 'object' as const,
      properties: {
        quote_type: { type: 'string', description: "报价类型，默认 'fxd_frn'" },
      },
      required: [],
    },
  },
];
