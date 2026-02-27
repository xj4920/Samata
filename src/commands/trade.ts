import { queryTrades, isInfluxConfigured, type TradeRecord } from '../db/influxdb.js';
import { loadCustomers } from '../config/customers.js';
import { renderTable } from '../utils/table.js';
import { log } from '../utils/logger.js';

function parseArgs(args: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)=(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    params[m[1].toLowerCase()] = m[2];
  }
  return params;
}

function formatNum(val: number | null): string {
  if (val == null) return '-';
  return Number(val).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export async function trade(args: string): Promise<void> {
  if (!isInfluxConfigured()) {
    log.error('InfluxDB 未配置，请在 .env 中设置 INFLUX_TOKEN');
    return;
  }

  const params = parseArgs(args);

  let parties: string[] | undefined;
  if (params.client) {
    const customers = loadCustomers();
    const match = customers.find(c => c.name.toLowerCase() === params.client.toLowerCase());
    if (!match) {
      log.error(`未找到管理人: ${params.client}`);
      log.dim(`可用: ${customers.map(c => c.name).join(', ')}`);
      return;
    }
    parties = match.products.map(p => p.counter_party);
    log.dim(`${match.name} → ${parties.join(', ')}`);
  }

  try {
    const records = await queryTrades({
      party: params.party,
      parties,
      user: params.user,
      date: params.date,
      limit: params.limit ? Number(params.limit) : undefined,
    });

    if (records.length === 0) {
      log.warn('未查询到交易数据');
      return;
    }

    log.info(`查询到 ${records.length} 条交易记录：`);

    const head = ['交易日期', '交易对手', 'USER', 'POS#', 'TRADE#', 'NOTIONAL(T-1)', 'TRADE_AMT', 'FT_NET'];
    const rows = records.map((r: TradeRecord) => [
      r.trade_dt ?? '-',
      r.counter_party ?? '-',
      r.user_id ?? '-',
      formatNum(r.pos_num),
      formatNum(r.trade_num),
      formatNum(r.notional_t_1),
      formatNum(r.trade_amt),
      formatNum(r.ft_net),
    ]);

    renderTable(head, rows);
  } catch (err: any) {
    log.error(`查询失败: ${err.message}`);
  }
}
