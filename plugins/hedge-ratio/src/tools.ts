import type { ToolDefinition } from '@samata-platform/plugin-sdk';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'query_hedge_short',
    description: '查询QFII对冲账户空头市值。支持按估值日期、产品名称过滤。返回字段：valuation_date(估值日期)、product_name(产品名称)、future_short_market_value(股指期货空头市值)、future_long_market_value(股指期货多头市值)、component_stocks_market_value(中证1800成分股市值)、hedge_ratio(套保比例)。',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: '估值日期，格式 YYYY-MM-DD' },
        product_name: { type: 'string', description: '产品名称，支持模糊匹配' },
        limit: { type: 'number', description: '返回条数上限，默认50' },
      },
      required: [],
    },
  },
];
