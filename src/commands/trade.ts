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
  date_from?: string;
  date_to?: string;
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
    date_from: params.date_from,
    date_to: params.date_to,
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

export interface ManagerTradeSummary {
  manager: string;
  pos_num: number;
  trade_num: number;
  notional_t: number;
  trade_amt_ft: number;
  ft_net: number;
}

/**
 * 按管理人汇总指定日期的交易数据
 */
export async function fetchTradeSummary(date?: string): Promise<{
  date: string;
  summaries: ManagerTradeSummary[];
  totalNotional: number;
  totalTradeAmt: number;
}> {
  if (!isInfluxConfigured()) throw new Error('InfluxDB 未配置');

  const customers = loadCustomers();
  const partyToManager = new Map<string, string>();
  for (const c of customers) {
    for (const p of c.products) {
      partyToManager.set(p.counter_party.toUpperCase(), c.name);
    }
  }

  const records = await queryTrades({ date, limit: 1000 });
  if (records.length === 0) {
    return { date: date || '-', summaries: [], totalNotional: 0, totalTradeAmt: 0 };
  }

  const actualDate = records[0].trade_dt || date || '-';
  const managerMap = new Map<string, ManagerTradeSummary>();

  // 按 counter_party 去重，只取每个 party 最新的一条（数据已按 time DESC 排序）
  const seen = new Set<string>();
  for (const r of records) {
    const party = (r.counter_party ?? '').toUpperCase();
    if (seen.has(party)) continue;
    seen.add(party);

    const manager = partyToManager.get(party) || '其他';
    const summary = managerMap.get(manager) || {
      manager,
      pos_num: 0,
      trade_num: 0,
      notional_t: 0,
      trade_amt_ft: 0,
      ft_net: 0,
    };

    summary.pos_num += r.pos_num || 0;
    summary.trade_num += r.trade_num || 0;
    summary.notional_t += (r.notional_ft_t_1 || 0) + (r.ft_net || 0);
    summary.trade_amt_ft += r.trade_amt_ft || 0;
    summary.ft_net += r.ft_net || 0;

    managerMap.set(manager, summary);
  }

  const summaries = Array.from(managerMap.values())
    .sort((a, b) => Math.abs(b.notional_t) - Math.abs(a.notional_t));

  const totalNotional = summaries.reduce((sum, s) => sum + s.notional_t, 0);
  const totalTradeAmt = summaries.reduce((sum, s) => sum + s.trade_amt_ft, 0);

  return {
    date: actualDate,
    summaries,
    totalNotional,
    totalTradeAmt,
  };
}

/**
 * 格式化金额：>=1亿用"亿"，<1亿用"万"
 */
function formatAmount(val: number, forceBillion = false): string {
  const abs = Math.abs(val);
  if (forceBillion || abs >= 100000000) {
    return `${(val / 100000000).toFixed(2)}亿`;
  }
  return `${Math.round(val / 10000).toLocaleString()}万`;
}

/**
 * 格式化净买入金额：带符号，>=1亿用"亿"，<1亿用"万"
 */
function formatNet(val: number): string {
  const prefix = val > 0 ? '+' : '';
  return prefix + formatAmount(val);
}

export async function trade(args: string): Promise<void> {
  const params = parseArgs(args);
  
  // 新增 summary 子命令支持
  if (args.includes('summary')) {
    try {
      const { date, summaries, totalNotional, totalTradeAmt } = await fetchTradeSummary(params.date);
      if (summaries.length === 0) {
        log.print('未查询到交易数据');
        return;
      }

      log.print(`📊 ${date} 交易日报 (按管理人汇总)`);
      const head = ['管理人', 'POS#', 'TRADE#', '名义金额', '成交金额', 'T日净买入'];
      const tableRows = summaries.map(s => [
        s.manager,
        formatNum(s.pos_num),
        formatNum(s.trade_num),
        formatAmount(s.notional_t, true),
        formatAmount(s.trade_amt_ft, true),
        formatNet(s.ft_net),
      ]);
      renderTable(head, tableRows);

      log.print('\n📌 当日交易汇总');
      log.print(`- 存续名义本金：${formatAmount(totalNotional, true)}`);
      log.print(`- 成交金额：${formatAmount(totalTradeAmt, true)}`);
      return;
    } catch (err: any) {
      log.print(err.message);
      return;
    }
  }

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
