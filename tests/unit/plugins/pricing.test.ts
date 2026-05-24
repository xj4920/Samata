import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getPricingDb, closePricingDb } from '../../../plugins/pricing/src/db.js';
import { importPricingQuote, queryPricingQuote, listPricingQuoteDates } from '../../../plugins/pricing/src/commands.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('pricing plugin', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-test-'));
    db = getPricingDb(tmpDir);
  });

  afterEach(() => {
    closePricingDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('DB schema', () => {
    it('creates pricing_quotes table', () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      expect(tables.map(t => t.name)).toContain('pricing_quotes');
    });

    it('creates index on agent_id + quote_type + quote_date', () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
      expect(indexes.map(i => i.name)).toContain('idx_pricing_quotes_agent_type');
    });
  });

  describe('importPricingQuote', () => {
    it('returns error for non-existent file', () => {
      const result = importPricingQuote(db, '/nonexistent/file.xlsx', 'agent-1', 'user-1');
      expect(result).toHaveProperty('success', false);
      expect((result as any).error).toContain('文件不存在');
    });

    it('dry_run=true does not write to DB', () => {
      const testFile = path.join(tmpDir, 'FXD_FRN_Daily_Update_20260501.xlsx');
      createTestExcel(testFile);

      const result = importPricingQuote(db, testFile, 'agent-1', 'user-1', undefined, true);
      expect(result).toHaveProperty('success', true);
      expect((result as any).dry_run).toBe(true);

      const count = db.prepare('SELECT COUNT(*) as c FROM pricing_quotes').get() as { c: number };
      expect(count.c).toBe(0);
    });

    it('dry_run=false writes to DB', () => {
      const testFile = path.join(tmpDir, 'FXD_FRN_Daily_Update_20260501.xlsx');
      createTestExcel(testFile);

      const result = importPricingQuote(db, testFile, 'agent-1', 'user-1', undefined, false);
      expect(result).toHaveProperty('success', true);
      expect((result as any).dry_run).toBe(false);
      expect((result as any).quote_type).toBe('fxd_frn');
      expect((result as any).quote_date).toBe('2026-05-01');

      const count = db.prepare('SELECT COUNT(*) as c FROM pricing_quotes').get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('upserts on same agent+type+date', () => {
      const testFile = path.join(tmpDir, 'FXD_FRN_Daily_Update_20260501.xlsx');
      createTestExcel(testFile);

      importPricingQuote(db, testFile, 'agent-1', 'user-1', undefined, false);
      importPricingQuote(db, testFile, 'agent-1', 'user-1', undefined, false);

      const count = db.prepare('SELECT COUNT(*) as c FROM pricing_quotes').get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('different agents create separate records', () => {
      const testFile = path.join(tmpDir, 'FXD_FRN_Daily_Update_20260501.xlsx');
      createTestExcel(testFile);

      importPricingQuote(db, testFile, 'agent-1', 'user-1', undefined, false);
      importPricingQuote(db, testFile, 'agent-2', 'user-1', undefined, false);

      const count = db.prepare('SELECT COUNT(*) as c FROM pricing_quotes').get() as { c: number };
      expect(count.c).toBe(2);
    });
  });

  describe('queryPricingQuote', () => {
    beforeEach(() => {
      seedQuotes(db);
    });

    it('returns latest quote when no date specified', () => {
      const result = queryPricingQuote(db, 'agent-1', {});
      expect(result).toHaveProperty('success', true);
      expect((result as any).quote_date).toBe('2026-05-02');
    });

    it('returns specific date', () => {
      const result = queryPricingQuote(db, 'agent-1', { date: '2026-05-01' });
      expect(result).toHaveProperty('success', true);
      expect((result as any).quote_date).toBe('2026-05-01');
    });

    it('filters by rate_type', () => {
      const result = queryPricingQuote(db, 'agent-1', { rate_type: 'Fixed' });
      expect(result).toHaveProperty('success', true);
      const results = (result as any).results;
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r: any) => r.type === 'Fixed')).toBe(true);
    });

    it('filters by tenor', () => {
      const result = queryPricingQuote(db, 'agent-1', { tenor: '3M' });
      expect(result).toHaveProperty('success', true);
      const results = (result as any).results;
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r: any) => r.tenor === '3M')).toBe(true);
    });

    it('filters by currency', () => {
      const result = queryPricingQuote(db, 'agent-1', { currency: 'USD' });
      expect(result).toHaveProperty('success', true);
      const results = (result as any).results;
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r: any) => 'USD' in r)).toBe(true);
    });

    it('returns empty results for non-existent agent', () => {
      const result = queryPricingQuote(db, 'agent-nonexist', {});
      expect(result).toHaveProperty('success', true);
      expect((result as any).results).toEqual([]);
    });

    it('normalizes rate_type aliases', () => {
      const r1 = queryPricingQuote(db, 'agent-1', { rate_type: 'fxd' });
      const r2 = queryPricingQuote(db, 'agent-1', { rate_type: 'Fixed' });
      expect((r1 as any).results).toEqual((r2 as any).results);
    });
  });

  describe('listPricingQuoteDates', () => {
    beforeEach(() => {
      seedQuotes(db);
    });

    it('returns dates in descending order', () => {
      const result = listPricingQuoteDates(db, 'agent-1');
      expect(result.dates).toEqual(['2026-05-02', '2026-05-01']);
    });

    it('returns empty for non-existent agent', () => {
      const result = listPricingQuoteDates(db, 'agent-nonexist');
      expect(result.dates).toEqual([]);
    });

    it('defaults to fxd_frn quote_type', () => {
      const result = listPricingQuoteDates(db, 'agent-1');
      expect(result.quote_type).toBe('fxd_frn');
    });
  });
});

// ─── Helpers ───

function createTestExcel(filePath: string) {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const data = [
    ['Issuer', 'Test Corp'],
    ['Guarantor', 'GF Securities'],
    ['Notional', 'USD 100M'],
    [],
    ['Fixed', 'USD', 'HKD', 'CNH'],
    ['1M', 0.045, 0.035, 0.032],
    ['3M', 0.048, 0.038, 0.035],
    ['6M', 0.052, 0.042, 0.039],
    [],
    ['Floating', 'USD', 'HKD', 'CNH'],
    ['1M', 0.042, 0.032, 0.029],
    ['3M', 0.045, 0.035, 0.032],
    ['6M', 0.049, 0.039, 0.036],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filePath);
}

function seedQuotes(db: Database.Database) {
  const data1 = JSON.stringify([
    { type: 'Fixed', tenor: '1M', USD: 0.045, HKD: 0.035 },
    { type: 'Fixed', tenor: '3M', USD: 0.048, HKD: 0.038 },
    { type: 'Floating', tenor: '1M', USD: 0.042, HKD: 0.032 },
    { type: 'Floating', tenor: '3M', USD: 0.045, HKD: 0.035 },
  ]);
  const data2 = JSON.stringify([
    { type: 'Fixed', tenor: '1M', USD: 0.046, HKD: 0.036 },
    { type: 'Fixed', tenor: '3M', USD: 0.049, HKD: 0.039 },
    { type: 'Floating', tenor: '1M', USD: 0.043, HKD: 0.033 },
    { type: 'Floating', tenor: '3M', USD: 0.046, HKD: 0.036 },
  ]);
  const metadata = JSON.stringify({ issuer: 'Test', guarantor: 'GF', notional: 'USD 100M' });

  db.prepare(`INSERT INTO pricing_quotes (id, agent_id, quote_type, quote_date, file_name, data, metadata, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('q1', 'agent-1', 'fxd_frn', '2026-05-01', 'test1.xlsx', data1, metadata, 'user-1');
  db.prepare(`INSERT INTO pricing_quotes (id, agent_id, quote_type, quote_date, file_name, data, metadata, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('q2', 'agent-1', 'fxd_frn', '2026-05-02', 'test2.xlsx', data2, metadata, 'user-1');
}
