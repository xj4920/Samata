import type { ToolDefinition } from '@samata-platform/plugin-sdk';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'query_trades',
    description: '查询交易成交记录（适合少量数据分析）。支持按管理人、交易对手、用户ID、日期过滤。导出CSV/全量数据请改用 export_trades_csv。',
    input_schema: {
      type: 'object' as const,
      properties: {
        client: { type: 'string', description: '管理人名称，如 JINDE、JUPITER、JUMP 等，会自动映射到其下所有交易对手' },
        party: { type: 'string', description: '交易对手名称，精确匹配' },
        user: { type: 'string', description: '用户ID' },
        date: { type: 'string', description: '精确匹配单日，格式 YYYYMMDD。设置此参数时 date_from/date_to 被忽略' },
        date_from: { type: 'string', description: '起始日期（含），格式 YYYYMMDD。与 date_to 配合做日期范围查询，查某月数据时优先用范围而非逐日调用' },
        date_to: { type: 'string', description: '结束日期（含），格式 YYYYMMDD' },
        limit: { type: 'number', description: '返回条数上限，默认50。日期范围查询时建议设为500' },
      },
      required: [],
    },
  },
  {
    name: 'trade_summary',
    description: '获取交易日报汇总（按管理人维度）。用户问"日报"、"汇总"、"按管理人看交易"时优先使用。后端完成数值累加，确保计算精度。字段含义和渲染规范请参考「交易数据查询与导出」skill。',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: '交易日期，格式 YYYYMMDD。默认查询最新一天的数据。' },
      },
      required: [],
    },
  },
  {
    name: 'plot_trades',
    description: '绘制交易曲线图（存续名义本金、成交金额、净头寸），生成HTML在浏览器中打开。适合用户要求"画图"、"图表"、"趋势"时调用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        client: { type: 'string', description: '管理人名称，如 JUMP、JINDE' },
        party: { type: 'string', description: '交易对手名称' },
        limit: { type: 'number', description: '数据条数上限，默认200' },
      },
      required: [],
    },
  },
  {
    name: 'list_customers',
    description: '列出所有管理人及其关联的交易对手/产品列表',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'export_trades_csv',
    description: '将交易数据导出为 CSV 文件（服务端直接写文件）。用户要求"导出CSV"、"全量数据"、"下载"时使用。筛选参数同 query_trades。',
    input_schema: {
      type: 'object' as const,
      properties: {
        client: { type: 'string', description: '管理人名称' },
        party: { type: 'string', description: '交易对手名称' },
        user: { type: 'string', description: '用户ID' },
        date: { type: 'string', description: '精确匹配单日，格式 YYYYMMDD' },
        date_from: { type: 'string', description: '起始日期（含），格式 YYYYMMDD' },
        date_to: { type: 'string', description: '结束日期（含），格式 YYYYMMDD' },
        columns: {
          type: 'array', items: { type: 'string' },
          description: '可选，指定输出列及顺序。可选值: date, client, counter_party, user_id, pos_num, trade_num, notional_t, trade_amt_ft, ft_net',
        },
        filename: { type: 'string', description: '输出文件名，默认自动生成' },
      },
      required: [],
    },
  },
  {
    name: 'export_north_info_csv',
    description: '导出北向极速交易数据（north_info）为 CSV。默认查最新一天快照；可用 date_from/date_to 做范围查询。列定义详见「交易数据查询与导出」skill。',
    input_schema: {
      type: 'object' as const,
      properties: {
        date_from: { type: 'string', description: '起始日期（含），格式 YYYYMMDD' },
        date_to: { type: 'string', description: '结束日期（含），格式 YYYYMMDD' },
        filename: { type: 'string', description: '输出文件名，默认 north_info_<date>.csv' },
      },
      required: [],
    },
  },
];
