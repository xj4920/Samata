import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { fetchTrades, fetchTradeSummary } from '../commands/trade.js';
import { plotTrades } from '../commands/plot.js';
import { loadCustomers } from '../config/customers.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'query_trades',
    description: '查询交易成交记录。支持按管理人名称(client)、交易对手(party)、用户ID(user)、日期过滤。查某段时间数据时使用 date_from/date_to 范围查询（一次调用即可），避免逐日循环调用。date 为精确匹配单日。管理人与交易对手为1:N映射关系，指定client会自动展开为其下所有交易对手。返回字段说明：notional_t=T日存续名义本金，trade_amt_ft=T日成交金额，ft_net=净交易头寸（非盈亏）。',
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
    description: '获取交易日报汇总（按管理人维度）。当用户询问"按管理人维度查看交易情况"、"日报"、"汇总"或要求提供特定日期的交易表格时，优先调用此工具。此工具在后端完成所有数值累加，确保计算精度。返回已排序的管理人维度汇总数据，包含名义金额、成交金额、净买入金额等。',
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
];

async function handleQueryTrades(input: { client?: string; party?: string; user?: string; date?: string; date_from?: string; date_to?: string; limit?: number }): Promise<string> {
  try {
    const rows = await fetchTrades(input);
    if (rows.length === 0) return JSON.stringify({ message: '未查询到交易数据' });
    return JSON.stringify(rows);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

async function handleTradeSummary(input: { date?: string }): Promise<string> {
  try {
    const result = await fetchTradeSummary(input.date);
    return JSON.stringify(result);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

async function handlePlotTrades(input: { client?: string; party?: string; limit?: number }): Promise<string> {
  try {
    const filePath = await plotTrades(input);
    return JSON.stringify({ success: true, message: '图表已在浏览器中打开', path: filePath });
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

function handleListCustomers(): string {
  const customers = loadCustomers();
  return JSON.stringify(customers.map(c => ({
    name: c.name,
    sales: c.sales,
    products: c.products.map((p: any) => p.counter_party),
  })));
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'query_trades': return handleQueryTrades(input);
    case 'trade_summary': return handleTradeSummary(input);
    case 'plot_trades': return handlePlotTrades(input);
    case 'list_customers': return handleListCustomers();
    default: return null;
  }
}
