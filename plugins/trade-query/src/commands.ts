import { queryTrades, isInfluxConfigured, type TradeRecord } from './influxdb.js';
import { loadCustomers } from './customers.js';

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

export interface ManagerTradeSummary {
  manager: string;
  pos_num: number;
  trade_num: number;
  notional_t: number;
  notional_short_t: number;
  trade_amt_ft: number;
  trade_amt_ft_short: number;
  ft_net: number;
  ft_net_short: number;
}

export async function fetchTradeSummary(date?: string): Promise<{
  date: string;
  summaries: ManagerTradeSummary[];
  totalNotional: number;
  totalNotionalShort: number;
  totalTradeAmt: number;
  totalTradeAmtShort: number;
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
    return {
      date: date || '-',
      summaries: [],
      totalNotional: 0,
      totalNotionalShort: 0,
      totalTradeAmt: 0,
      totalTradeAmtShort: 0,
    };
  }

  const actualDate = records[0].trade_dt || date || '-';
  const managerMap = new Map<string, ManagerTradeSummary>();

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
      notional_short_t: 0,
      trade_amt_ft: 0,
      trade_amt_ft_short: 0,
      ft_net: 0,
      ft_net_short: 0,
    };

    summary.pos_num += r.pos_num || 0;
    summary.trade_num += r.trade_num || 0;
    summary.notional_t += (r.notional_ft_t_1 || 0) + (r.ft_net || 0);
    summary.notional_short_t += r.notional_ft_short_t || 0;
    summary.trade_amt_ft += r.trade_amt_ft || 0;
    summary.trade_amt_ft_short += r.trade_amt_ft_short || 0;
    summary.ft_net += r.ft_net || 0;
    summary.ft_net_short += r.ft_net_short || 0;

    managerMap.set(manager, summary);
  }

  const summaries = Array.from(managerMap.values())
    .sort((a, b) => Math.abs(b.notional_t) - Math.abs(a.notional_t));

  const totalNotional = summaries.reduce((sum, s) => sum + s.notional_t, 0);
  const totalNotionalShort = summaries.reduce((sum, s) => sum + s.notional_short_t, 0);
  const totalTradeAmt = summaries.reduce((sum, s) => sum + s.trade_amt_ft, 0);
  const totalTradeAmtShort = summaries.reduce((sum, s) => sum + s.trade_amt_ft_short, 0);

  return {
    date: actualDate,
    summaries,
    totalNotional,
    totalNotionalShort,
    totalTradeAmt,
    totalTradeAmtShort,
  };
}

export interface NorthInfoRow {
  trade_dt: string;
  counter_party_short_name: string;
  notional_ft_t: number;
  notional_ft_short_t: number;
  trade_amt_ft: number;
  trade_amt_ft_short: number;
  ft_net: number;
  ft_net_short: number;
  is_ft: 'Y' | 'N' | '';
  update_time: string;
}

function normalizeIsFt(raw: string | null | undefined): 'Y' | 'N' | '' {
  if (raw == null) return '';
  const s = String(raw).trim().toLowerCase();
  if (s === '') return '';
  if (s === '1' || s === 'y' || s === 'true' || s === 't') return 'Y';
  return 'N';
}

export async function fetchNorthInfo(params: {
  date_from?: string;
  date_to?: string;
  limit?: number;
}): Promise<{ rows: NorthInfoRow[]; tradeDate: string }> {
  if (!isInfluxConfigured()) throw new Error('InfluxDB 未配置');

  const hasRange = !!(params.date_from || params.date_to);
  const records = await queryTrades({
    date_from: params.date_from,
    date_to: params.date_to,
    limit: params.limit ?? (hasRange ? 5000 : 1000),
  });

  if (records.length === 0) return { rows: [], tradeDate: '-' };

  const picked = hasRange
    ? records
    : (() => {
        const seen = new Set<string>();
        const out: typeof records = [];
        for (const r of records) {
          const party = (r.counter_party ?? '').toUpperCase();
          if (!party || seen.has(party)) continue;
          seen.add(party);
          out.push(r);
        }
        return out;
      })();

  const rows: NorthInfoRow[] = picked.map(r => ({
    trade_dt: r.trade_dt ?? '-',
    counter_party_short_name: r.counter_party ?? '-',
    notional_ft_t: (r.notional_ft_t_1 ?? 0) + (r.ft_net ?? 0),
    notional_ft_short_t: r.notional_ft_short_t ?? 0,
    trade_amt_ft: r.trade_amt_ft ?? 0,
    trade_amt_ft_short: r.trade_amt_ft_short ?? 0,
    ft_net: r.ft_net ?? 0,
    ft_net_short: -(r.ft_net_short ?? 0),
    is_ft: normalizeIsFt(r.is_ft),
    update_time: r.update_time ?? '',
  }));

  rows.sort((a, b) =>
    a.trade_dt.localeCompare(b.trade_dt) ||
    a.counter_party_short_name.localeCompare(b.counter_party_short_name)
  );

  const tradeDate = hasRange
    ? `${rows[0].trade_dt}~${rows[rows.length - 1].trade_dt}`
    : rows[0].trade_dt;

  return { rows, tradeDate };
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
