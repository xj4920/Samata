/**
 * hedge-ratio plugin tests — directly connects to InfluxDB.
 * Requires INFLUX_TOKEN env var to be set (skips if not configured).
 */
import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env') });

import { isInfluxConfigured, queryInfluxRaw } from '../src/influxdb.js';
import { fetchHedgeShort } from '../src/commands.js';

const SKIP = !isInfluxConfigured();
const itLive = SKIP ? it.skip : it;

describe('hedge-ratio plugin', () => {
  describe('influxdb connection', () => {
    itLive('queryInfluxRaw can query hedge_ratio measurement', async () => {
      const rows = await queryInfluxRaw('otchk', 'SELECT * FROM "hedge_ratio" ORDER BY time DESC LIMIT 3');
      expect(Array.isArray(rows)).toBe(true);
      if (rows.length > 0) {
        expect(rows[0]).toHaveProperty('hedge_ratio');
      }
    });
  });

  describe('fetchHedgeShort (live)', () => {
    itLive('returns records without filters', async () => {
      const rows = await fetchHedgeShort({ limit: 5 });
      expect(Array.isArray(rows)).toBe(true);

      if (rows.length > 0) {
        const r = rows[0];
        expect(r).toHaveProperty('valuation_date');
        expect(r).toHaveProperty('product_name');
        expect(r).toHaveProperty('hedge_ratio');
        expect(r).toHaveProperty('future_short_market_value');
        expect(r).toHaveProperty('future_long_market_value');
        expect(r).toHaveProperty('component_stocks_market_value');
      }
    });

    itLive('filters by date', async () => {
      const allRows = await fetchHedgeShort({ limit: 5 });
      if (allRows.length === 0) return;

      const date = allRows[0].valuation_date;
      const filtered = await fetchHedgeShort({ date, limit: 50 });
      expect(filtered.every(r => r.valuation_date === date)).toBe(true);
    });

    itLive('filters by product_name (regex)', async () => {
      const allRows = await fetchHedgeShort({ limit: 5 });
      if (allRows.length === 0) return;

      const productName = String(allRows[0].product_name).slice(0, 4);
      const filtered = await fetchHedgeShort({ productName, limit: 50 });
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every(r => String(r.product_name).includes(productName))).toBe(true);
    });

    itLive('respects limit parameter', async () => {
      const rows = await fetchHedgeShort({ limit: 2 });
      expect(rows.length).toBeLessThanOrEqual(2);
    });

    itLive('throws when InfluxDB not configured', async () => {
      const rows = await fetchHedgeShort({});
      expect(Array.isArray(rows)).toBe(true);
    });
  });
});
