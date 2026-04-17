import { getDb } from '../db/connection.js';
import { getCurrentUser } from '../auth/rbac.js';
import { getCurrentAgent } from '../llm/agents/config.js';
import { v4 as uuid } from 'uuid';
import XLSX from 'xlsx';
import * as path from 'path';
import * as fs from 'fs';

interface FxdFrnRow {
  type: 'Fixed' | 'Floating';
  tenor: string;
  [currency: string]: string | number;
}

interface FxdFrnMetadata {
  issuer: string;
  guarantor: string;
  notional: string;
}

interface PricingQuoteRecord {
  id: string;
  agent_id: string;
  quote_type: string;
  quote_date: string;
  file_name: string | null;
  data: string;
  metadata: string | null;
  created_by: string;
  created_at: string;
}

function extractDateFromFileName(fileName: string): string | null {
  const match = fileName.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const compact = fileName.match(/(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return null;
}

function inferQuoteType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.includes('fxd') || lower.includes('frn')) return 'fxd_frn';
  return 'unknown';
}

function parseFxdFrnExcel(filePath: string): { data: FxdFrnRow[]; metadata: FxdFrnMetadata } {
  const resolved = filePath.startsWith('~/')
    ? path.join(process.env.HOME || '', filePath.slice(1))
    : path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`文件不存在: ${resolved}`);
  }

  const workbook = XLSX.readFile(resolved);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) throw new Error(`Sheet不存在: ${sheetName}`);

  const rawRows: string[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  let issuer = '';
  let guarantor = '';
  let notional = '';

  for (const row of rawRows) {
    const cell0 = String(row[0] ?? '').trim();
    const cell1 = String(row[1] ?? '').trim();
    if (cell0.toLowerCase().startsWith('issuer')) {
      issuer = cell1 || cell0.replace(/^issuer\s*:\s*/i, '');
    }
    if (cell0.toLowerCase().startsWith('guarantor')) {
      guarantor = cell1 || cell0.replace(/^guarantor\s*:\s*/i, '');
    }
    if (cell0.toLowerCase().includes('notional') || cell1.toLowerCase().includes('notional')) {
      notional = [cell0, cell1, String(row[2] ?? '')].filter(Boolean).join(' ').replace(/[\r\n]+/g, ' ').trim();
    }
  }

  const data: FxdFrnRow[] = [];
  let currentType: 'Fixed' | 'Floating' | null = null;
  let currencies: string[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const cell0 = String(row[0] ?? '').trim();

    if (cell0 === 'Fixed' || cell0 === 'Floating') {
      currentType = cell0 as 'Fixed' | 'Floating';
      currencies = [];
      for (let j = 1; j < row.length; j++) {
        const val = String(row[j] ?? '').trim();
        if (val && /^[A-Z]{3}$/.test(val)) {
          currencies.push(val);
        }
      }
      continue;
    }

    if (currentType && cell0 && /^\d+[MmYy]$/.test(cell0)) {
      const tenor = cell0.toUpperCase();
      const entry: FxdFrnRow = { type: currentType, tenor };
      for (let j = 0; j < currencies.length; j++) {
        const rawVal = row[j + 1];
        const numVal = typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal ?? ''));
        entry[currencies[j]] = isNaN(numVal) ? 0 : numVal;
      }
      data.push(entry);
    }
  }

  return { data, metadata: { issuer, guarantor, notional } };
}

export function importPricingQuote(
  filePath: string,
  quoteType?: string,
  dryRun: boolean = true
): { success: true; quote_type: string; quote_date: string; data: FxdFrnRow[]; metadata: FxdFrnMetadata; dry_run: boolean } | { success: false; error: string } {
  const agent = getCurrentAgent();
  if (!agent) return { success: false, error: '未找到当前 Agent' };

  const fileName = path.basename(filePath);
  const resolved = filePath.startsWith('~/')
    ? path.join(process.env.HOME || '', filePath.slice(1))
    : path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    return { success: false, error: `文件不存在: ${resolved}` };
  }

  let parsed: { data: FxdFrnRow[]; metadata: FxdFrnMetadata };
  try {
    parsed = parseFxdFrnExcel(filePath);
  } catch (e: any) {
    return { success: false, error: `Excel解析失败: ${e.message}` };
  }

  const effectiveQuoteType = quoteType || inferQuoteType(fileName);
  const quoteDate = extractDateFromFileName(fileName) || new Date().toISOString().slice(0, 10);

  if (dryRun) {
    return {
      success: true,
      quote_type: effectiveQuoteType,
      quote_date: quoteDate,
      data: parsed.data,
      metadata: parsed.metadata,
      dry_run: true,
    };
  }

  const db = getDb();
  const user = getCurrentUser();

  const existing = db.prepare(
    'SELECT id FROM pricing_quotes WHERE agent_id = ? AND quote_type = ? AND quote_date = ?'
  ).get(agent.id, effectiveQuoteType, quoteDate) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      'UPDATE pricing_quotes SET data = ?, metadata = ?, file_name = ?, created_by = ?, created_at = datetime(\'now\') WHERE id = ?'
    ).run(JSON.stringify(parsed.data), JSON.stringify(parsed.metadata), fileName, user.id, existing.id);
  } else {
    db.prepare(
      'INSERT INTO pricing_quotes (id, agent_id, quote_type, quote_date, file_name, data, metadata, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uuid(), agent.id, effectiveQuoteType, quoteDate, fileName, JSON.stringify(parsed.data), JSON.stringify(parsed.metadata), user.id);
  }

  return {
    success: true,
    quote_type: effectiveQuoteType,
    quote_date: quoteDate,
    data: parsed.data,
    metadata: parsed.metadata,
    dry_run: false,
  };
}

export function queryPricingQuote(options: {
  quote_type?: string;
  date?: string;
  currency?: string;
  tenor?: string;
  rate_type?: string;
}): { success: true; quote_type: string; quote_date: string; metadata: FxdFrnMetadata | null; results: any[] } | { success: false; error: string } {
  const agent = getCurrentAgent();
  if (!agent) return { success: false, error: '未找到当前 Agent' };

  const db = getDb();
  const effectiveQuoteType = options.quote_type || 'fxd_frn';

  let record: PricingQuoteRecord | undefined;

  if (options.date) {
    record = db.prepare(
      'SELECT * FROM pricing_quotes WHERE agent_id = ? AND quote_type = ? AND quote_date = ?'
    ).get(agent.id, effectiveQuoteType, options.date) as PricingQuoteRecord | undefined;
  } else {
    record = db.prepare(
      'SELECT * FROM pricing_quotes WHERE agent_id = ? AND quote_type = ? ORDER BY quote_date DESC LIMIT 1'
    ).get(agent.id, effectiveQuoteType) as PricingQuoteRecord | undefined;
  }

  if (!record) {
    return {
      success: true,
      quote_type: effectiveQuoteType,
      quote_date: options.date || 'latest',
      metadata: null,
      results: [],
    };
  }

  const allRows: FxdFrnRow[] = JSON.parse(record.data);
  const metadata: FxdFrnMetadata | null = record.metadata ? JSON.parse(record.metadata) : null;

  let filtered = allRows;

  if (options.rate_type) {
    const RATE_TYPE_MAP: Record<string, string> = { fixed: 'Fixed', fix: 'Fixed', fxd: 'Fixed', floating: 'Floating', float: 'Floating', frn: 'Floating' };
    const rt = RATE_TYPE_MAP[options.rate_type.toLowerCase()]
      || options.rate_type.charAt(0).toUpperCase() + options.rate_type.slice(1).toLowerCase();
    filtered = filtered.filter(r => r.type === rt);
  }

  if (options.tenor) {
    const t = options.tenor.toUpperCase();
    filtered = filtered.filter(r => r.tenor === t);
  }

  const results = filtered.map(r => {
    const entry: Record<string, any> = { type: r.type, tenor: r.tenor };
    if (options.currency) {
      const c = options.currency.toUpperCase();
      entry[c] = r[c] ?? null;
    } else {
      for (const [k, v] of Object.entries(r)) {
        if (k !== 'type' && k !== 'tenor') {
          entry[k] = v;
        }
      }
    }
    return entry;
  });

  return {
    success: true,
    quote_type: effectiveQuoteType,
    quote_date: record.quote_date,
    metadata,
    results,
  };
}

export function listPricingQuoteDates(quoteType?: string): { quote_type: string; dates: string[] } {
  const agent = getCurrentAgent();
  if (!agent) return { quote_type: quoteType || 'fxd_frn', dates: [] };

  const db = getDb();
  const effectiveQuoteType = quoteType || 'fxd_frn';

  const rows = db.prepare(
    'SELECT quote_date FROM pricing_quotes WHERE agent_id = ? AND quote_type = ? ORDER BY quote_date DESC'
  ).all(agent.id, effectiveQuoteType) as { quote_date: string }[];

  return {
    quote_type: effectiveQuoteType,
    dates: rows.map(r => r.quote_date),
  };
}
