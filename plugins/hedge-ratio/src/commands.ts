import { queryInfluxRaw, isInfluxConfigured } from './influxdb.js';

const DB = 'otchk';
const MEASUREMENT = 'hedge_ratio';

export interface HedgeShortParams {
  date?: string;
  productName?: string;
  limit?: number;
}

export async function fetchHedgeShort(params: HedgeShortParams = {}): Promise<Record<string, any>[]> {
  if (!isInfluxConfigured()) throw new Error('InfluxDB 未配置');

  const conditions: string[] = [];

  if (params.date) {
    conditions.push(`"valuation_date" = '${params.date.replace(/'/g, "\\'")}'`);
  }
  if (params.productName) {
    const escaped = params.productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    conditions.push(`"product_name" =~ /${escaped}/`);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 50;

  const q = `SELECT valuation_date, product_name, future_short_market_value, future_long_market_value, component_stocks_market_value, hedge_ratio FROM "${MEASUREMENT}"${where} ORDER BY time DESC LIMIT ${limit}`;

  return queryInfluxRaw(DB, q);
}
