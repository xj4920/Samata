import { queryTrades, isInfluxConfigured } from '../db/influxdb.js';
import { loadCustomers } from '../config/customers.js';
import { renderTable } from '../utils/table.js';
import { log } from '../utils/logger.js';

export interface TradeRow {
  date: string;
  client: string;
  counter_party: string;
  user_id: string;
  pos_num: number | null;
  trade_num: number | null;
  notional_t: number;
  trade_amt_ft: number | null;
  ft_net: number | null;
}

export async function fetchTrades(params: {
  client?: string;
  party?: string;
  user?: string;
  date?: string;
  limit?: number;
}): Promise<TradeRow[]> {
  if (!isInfluxConfigured()) throw new Error('InfluxDB 未配置');

  const customers = loadCustomers();
  const partyToClient = new Map<string, string>();
  for (const c of customers) {
    for (const p of c.products) {
      partyToClient.set(p.counter_party.toUpperCase(), c.name);
    }
  }

  let parties: string[] | undefined;
  if (params.client) {
    const match = customers.find(c => c.name.toLowerCase() === params.client!.toLowerCase());
    if (!match) {
      const names = customers.map(c => c.name).join(', ');
      throw new Error(`未找到管理人: ${params.client}，可用: ${names}`);
    }
    parties = match.products.map(p => p.counter_party);
  }

  const records = await queryTrades({
    party: params.party,
    parties,
    user: params.user,
    date: params.date,
    limit: params.limit,
  });

  records.sort((a, b) => Math.abs(b.trade_amt_ft ?? 0) - Math.abs(a.trade_amt_ft ?? 0));

  return records.map(r => ({
    date: r.trade_dt ?? '-',
    client: partyToClient.get((r.counter_party ?? '').toUpperCase()) ?? '-',
    counter_party: r.counter_party ?? '-',
    user_id: r.user_id ?? '-',
    pos_num: r.pos_num,
    trade_num: r.trade_num,
    notional_t: (r.notional_ft_t_1 ?? 0) + (r.ft_net ?? 0),
    trade_amt_ft: r.trade_amt_ft,
    ft_net: r.ft_net,
  }));
}

function parseArgs(args: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)=(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    params[m[1].toLowerCase()] = m[2];
  }
  return params;
}

export function formatNum(val: number | null): string {
  if (val == null) return '-';
  return Number(val).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export async function trade(args: string): Promise<void> {
  const params = parseArgs(args);
  try {
    const rows = await fetchTrades({
      client: params.client,
      party: params.party,
      user: params.user,
      date: params.date,
      limit: params.limit ? Number(params.limit) : undefined,
    });

    if (rows.length === 0) {
      log.print('未查询到交易数据');
      return;
    }

    log.print(`查询到 ${rows.length} 条交易记录：`);

    const head = ['交易日期', '客户名称', '交易对手', 'USER', 'POS#', 'TRADE#', 'T日存续名本', 'T日成交金额', '净交易头寸'];
    const tableRows = rows.map(r => [
      r.date,
      r.client,
      r.counter_party,
      r.user_id,
      formatNum(r.pos_num),
      formatNum(r.trade_num),
      formatNum(r.notional_t),
      formatNum(r.trade_amt_ft),
      formatNum(r.ft_net),
    ]);

    renderTable(head, tableRows);
  } catch (err: any) {
    log.print(err.message);
  }
}

export interface ClientTradeData {
  notional_t: number;
  trade_amt_ft: number;
}

export interface LatestTradeResult {
  data: Map<string, ClientTradeData>;
  tradeDate: string;
}

export async function fetchLatestNotionals(): Promise<Map<string, number>> {
  if (!isInfluxConfigured()) return new Map();

  const { data } = await fetchLatestTradeData();
  const result = new Map<string, number>();
  for (const [client, d] of data) {
    result.set(client, d.notional_t);
  }
  return result;
}

export async function fetchLatestTradeData(): Promise<LatestTradeResult> {
  const emptyResult: LatestTradeResult = { data: new Map(), tradeDate: '-' };
  if (!isInfluxConfigured()) return emptyResult;

  const customers = loadCustomers();
  const partyToClient = new Map<string, string>();
  for (const c of customers) {
    for (const p of c.products) {
      partyToClient.set(p.counter_party.toUpperCase(), c.name.toLowerCase());
    }
  }

  const records = await queryTrades({ limit: 500 });

  const seen = new Set<string>();
  const data = new Map<string, ClientTradeData>();
  let tradeDate = '-';

  for (const r of records) {
    const party = (r.counter_party ?? '').toUpperCase();
    if (seen.has(party)) continue;
    seen.add(party);

    const client = partyToClient.get(party);
    if (!client) continue;

    // 取第一条记录的日期作为交易日期（数据按时间倒序，最新在前）
    if (tradeDate === '-' && r.trade_dt) {
      tradeDate = r.trade_dt;
    }

    const notional = (r.notional_ft_t_1 ?? 0) + (r.ft_net ?? 0);
    const tradeAmt = r.trade_amt_ft ?? 0;

    const existing = data.get(client) ?? { notional_t: 0, trade_amt_ft: 0 };
    existing.notional_t += notional;
    existing.trade_amt_ft += tradeAmt;
    data.set(client, existing);
  }

  return { data, tradeDate };
}
