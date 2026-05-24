const INFLUX_HOST = process.env.INFLUX_HOST ?? '175.178.64.67';
const INFLUX_PORT = process.env.INFLUX_PORT ?? '8181';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN ?? '';
const INFLUX_DATABASE = process.env.INFLUX_DATABASE ?? 'otchk';
const INFLUX_TIMEOUT = Number(process.env.INFLUX_TIMEOUT ?? '60') * 1000;

const BASE_URL = `http://${INFLUX_HOST}:${INFLUX_PORT}`;

export interface TradeRecord {
  time: string;
  counter_party: string;
  user_id: string;
  is_ft: string;
  trade_dt: string;
  pos_num: number | null;
  trade_num: number | null;
  notional_t_1: number | null;
  notional_ft_t_1: number | null;
  notional_ft_short_t: number | null;
  trade_amt: number | null;
  trade_amt_ft: number | null;
  trade_amt_ft_short: number | null;
  ft_net: number | null;
  ft_net_short: number | null;
  update_time: string | null;
}

export async function queryInflux(influxQL: string): Promise<TradeRecord[]> {
  const url = `${BASE_URL}/query?db=${encodeURIComponent(INFLUX_DATABASE)}&q=${encodeURIComponent(influxQL)}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      ...(INFLUX_TOKEN ? { 'Authorization': `Token ${INFLUX_TOKEN}` } : {}),
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(INFLUX_TIMEOUT),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`InfluxDB query failed (${resp.status}): ${body}`);
  }

  const json = await resp.json() as {
    results: Array<{
      series?: Array<{
        columns: string[];
        values: any[][];
      }>;
      error?: string;
    }>;
  };

  const result = json.results?.[0];
  if (result?.error) {
    throw new Error(`InfluxDB error: ${result.error}`);
  }

  const series = result?.series?.[0];
  if (!series) return [];

  const { columns, values } = series;
  return values.map(row => {
    const record: any = {};
    columns.forEach((col, i) => {
      record[col] = row[i];
    });
    return record as TradeRecord;
  });
}

export interface TradeQueryParams {
  party?: string;
  parties?: string[];
  user?: string;
  date?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

function enumerateYearMonths(fromYM: string, toYM: string): string[] {
  const result: string[] = [];
  let y = parseInt(fromYM.slice(0, 4));
  let m = parseInt(fromYM.slice(4, 6));
  const endY = parseInt(toYM.slice(0, 4));
  const endM = parseInt(toYM.slice(4, 6));
  while (y < endY || (y === endY && m <= endM)) {
    result.push(`${y}${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
    if (result.length > 24) break;
  }
  return result;
}

export async function queryTrades(params: TradeQueryParams = {}): Promise<TradeRecord[]> {
  const conditions: string[] = [];
  let dateFrom: string | undefined;
  let dateTo: string | undefined;

  if (params.parties && params.parties.length > 0) {
    const pattern = params.parties.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    conditions.push(`"counter_party" =~ /^(${pattern})$/`);
  } else if (params.party) {
    conditions.push(`"counter_party" = '${params.party.replace(/'/g, "\\'")}'`);
  }
  if (params.user) {
    conditions.push(`"user_id" = '${params.user.replace(/'/g, "\\'")}'`);
  }
  if (params.date) {
    conditions.push(`"trade_dt" = '${params.date.replace(/'/g, "\\'")}'`);
  } else if (params.date_from || params.date_to) {
    dateFrom = params.date_from;
    dateTo = params.date_to;
    const fromYM = (dateFrom || '200001').slice(0, 6);
    const toYM = (dateTo || '209912').slice(0, 6);
    const months = enumerateYearMonths(fromYM, toYM);
    if (months.length === 1) {
      conditions.push(`"trade_dt" =~ /^${months[0]}/`);
    } else if (months.length <= 24) {
      conditions.push(`"trade_dt" =~ /^(${months.join('|')})/`);
    }
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 50;

  const q = `SELECT * FROM "north_info"${where} ORDER BY time DESC LIMIT ${limit}`;
  let records = await queryInflux(q);

  if (dateFrom || dateTo) {
    records = records.filter(r => {
      const dt = r.trade_dt ?? '';
      if (dateFrom && dt < dateFrom) return false;
      if (dateTo && dt > dateTo) return false;
      return true;
    });
  }

  return records;
}

export function isInfluxConfigured(): boolean {
  return !!INFLUX_TOKEN;
}
