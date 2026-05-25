/**
 * trade-query plugin tests — directly connects to InfluxDB.
 * Requires INFLUX_TOKEN env var to be set (skips if not configured).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(process.cwd(), '.env') });

import { isInfluxConfigured, queryTrades } from '../src/influxdb.js';
import { fetchTrades, fetchTradeSummary, fetchNorthInfo, fetchLatestTradeData } from '../src/commands.js';
import { loadCustomers, setConfigDir } from '../src/customers.js';

const SKIP = !isInfluxConfigured();
const itLive = SKIP ? it.skip : it;

describe('trade-query plugin', () => {
  beforeAll(() => {
    setConfigDir(resolve(__dirname, '../config'));
  });

  describe('customers config', () => {
    it('loads customers.json', () => {
      const customers = loadCustomers();
      expect(customers.length).toBeGreaterThan(0);
      expect(customers[0]).toHaveProperty('name');
      expect(customers[0]).toHaveProperty('products');
    });

    it('each customer has products with counter_party', () => {
      const customers = loadCustomers();
      for (const c of customers) {
        expect(c.products.length).toBeGreaterThan(0);
        for (const p of c.products) {
          expect(p.counter_party).toBeTruthy();
        }
      }
    });
  });

  describe('influxdb (live)', () => {
    itLive('queryTrades returns records', async () => {
      const records = await queryTrades({ limit: 5 });
      expect(records.length).toBeGreaterThan(0);
      expect(records[0]).toHaveProperty('counter_party');
      expect(records[0]).toHaveProperty('trade_dt');
    });

    itLive('queryTrades with party filter', async () => {
      const allRecords = await queryTrades({ limit: 10 });
      if (allRecords.length === 0) return;

      const party = allRecords[0].counter_party;
      const filtered = await queryTrades({ party, limit: 5 });
      expect(filtered.every(r => r.counter_party === party)).toBe(true);
    });
  });

  describe('fetchTrades (live)', () => {
    itLive('returns formatted trade rows', async () => {
      const rows = await fetchTrades({ limit: 5 });
      expect(rows.length).toBeGreaterThan(0);

      const row = rows[0];
      expect(row).toHaveProperty('date');
      expect(row).toHaveProperty('client');
      expect(row).toHaveProperty('counter_party');
      expect(row).toHaveProperty('notional_t');
      expect(typeof row.notional_t).toBe('number');
    });

    itLive('filters by client name', async () => {
      const customers = loadCustomers();
      if (customers.length === 0) return;

      const clientName = customers[0].name;
      const rows = await fetchTrades({ client: clientName, limit: 10 });
      if (rows.length === 0) return;

      expect(rows.every(r => r.client === clientName)).toBe(true);
    });

    itLive('throws on unknown client', async () => {
      await expect(fetchTrades({ client: 'NONEXISTENT_CLIENT_XYZ' }))
        .rejects.toThrow('未找到管理人');
    });
  });

  describe('fetchTradeSummary (live)', () => {
    itLive('returns summary with manager breakdown', async () => {
      const result = await fetchTradeSummary();
      expect(result).toHaveProperty('date');
      expect(result).toHaveProperty('summaries');
      expect(result).toHaveProperty('totalNotional');

      if (result.summaries.length > 0) {
        const s = result.summaries[0];
        expect(s).toHaveProperty('manager');
        expect(s).toHaveProperty('notional_t');
        expect(s).toHaveProperty('trade_amt_ft');
        expect(s).toHaveProperty('ft_net');
      }
    });

    itLive('summaries sorted by notional desc', async () => {
      const result = await fetchTradeSummary();
      for (let i = 1; i < result.summaries.length; i++) {
        expect(Math.abs(result.summaries[i - 1].notional_t))
          .toBeGreaterThanOrEqual(Math.abs(result.summaries[i].notional_t));
      }
    });
  });

  describe('fetchNorthInfo (live)', () => {
    itLive('returns north info rows', async () => {
      const { rows, tradeDate } = await fetchNorthInfo({});
      expect(tradeDate).not.toBe('-');

      if (rows.length > 0) {
        const r = rows[0];
        expect(r).toHaveProperty('trade_dt');
        expect(r).toHaveProperty('counter_party_short_name');
        expect(r).toHaveProperty('notional_ft_t');
        expect(r).toHaveProperty('ft_net_short');
        expect(r).toHaveProperty('is_ft');
        expect(['Y', 'N', '']).toContain(r.is_ft);
      }
    });

    itLive('rows sorted by trade_dt then party', async () => {
      const { rows } = await fetchNorthInfo({});
      for (let i = 1; i < rows.length; i++) {
        const cmp = rows[i - 1].trade_dt.localeCompare(rows[i].trade_dt) ||
          rows[i - 1].counter_party_short_name.localeCompare(rows[i].counter_party_short_name);
        expect(cmp).toBeLessThanOrEqual(0);
      }
    });
  });

  describe('fetchLatestTradeData (live)', () => {
    itLive('returns aggregated data by client', async () => {
      const { data, tradeDate } = await fetchLatestTradeData();
      expect(tradeDate).not.toBe('-');

      if (data.size > 0) {
        const [, value] = data.entries().next().value!;
        expect(value).toHaveProperty('notional_t');
        expect(value).toHaveProperty('trade_amt_ft');
      }
    });
  });
});
