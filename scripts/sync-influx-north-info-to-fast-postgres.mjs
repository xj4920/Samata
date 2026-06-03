#!/usr/bin/env node
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const INFLUX_LIMIT = Number(process.env.INFLUX_HISTORY_MONTH_LIMIT ?? '100000');

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function normalizeDate(value, label = 'date') {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!match) throw new Error(`${label} must be YYYYMMDD or YYYY-MM-DD`);
  return `${match[1]}${match[2]}${match[3]}`;
}

function pgDate(date) {
  const d = normalizeDate(date);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function enumerateMonths(fromDate, toDate) {
  const from = normalizeDate(fromDate);
  const to = normalizeDate(toDate);
  const months = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(4, 6));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(4, 6));
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

function numberOrZero(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function intOrZero(value) {
  return Math.trunc(numberOrZero(value));
}

function normalizeIsFt(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return '';
  if (['1', 'y', 'yes', 'true', 't'].includes(s)) return 'Y';
  return 'N';
}

function normalizeTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text || text.toUpperCase() === 'DELETED') return null;
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text : null;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

async function queryInflux(influxql) {
  const host = requireEnv('INFLUX_HOST');
  const port = process.env.INFLUX_PORT ?? '8181';
  const db = process.env.INFLUX_DATABASE ?? 'otchk';
  const token = requireEnv('INFLUX_TOKEN');
  const url = `http://${host}:${port}/query?db=${encodeURIComponent(db)}&q=${encodeURIComponent(influxql)}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Token ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(Number(process.env.INFLUX_TIMEOUT ?? '60') * 1000),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`InfluxDB HTTP ${resp.status}: ${body}`);
  const json = JSON.parse(body);
  const result = json.results?.[0];
  if (result?.error) throw new Error(`InfluxDB error: ${result.error}`);
  const series = result?.series?.[0];
  if (!series) return [];
  return series.values.map((row) => Object.fromEntries(series.columns.map((column, i) => [column, row[i]])));
}

async function detectDateBounds() {
  const [first] = await queryInflux('SELECT * FROM "north_info" ORDER BY time ASC LIMIT 1');
  const [last] = await queryInflux('SELECT * FROM "north_info" ORDER BY time DESC LIMIT 1');
  if (!first?.trade_dt || !last?.trade_dt) throw new Error('Unable to detect north_info date range');
  return {
    dateFrom: normalizeDate(first.trade_dt, 'first trade_dt'),
    dateTo: normalizeDate(last.trade_dt, 'last trade_dt'),
  };
}

function createPgClient() {
  return new pg.Client({
    host: process.env.FAST_TRADING_PG_HOST ?? process.env.LOG_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.FAST_TRADING_PG_PORT ?? process.env.LOG_PG_PORT ?? '5432'),
    user: process.env.FAST_TRADING_PG_USER ?? process.env.LOG_PG_USER ?? 'wind_sync',
    password: process.env.FAST_TRADING_PG_PASSWORD ?? process.env.LOG_PG_PASS ?? 'wind_sync',
    database: process.env.FAST_TRADING_PG_DATABASE ?? process.env.LOG_PG_DB ?? 'samata',
    connectionTimeoutMillis: Number(process.env.FAST_TRADING_PG_CONNECT_TIMEOUT_MS ?? '5000'),
  });
}

async function ensureTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS samata_fast_trading_summary_files (
      trade_date DATE PRIMARY KEY,
      remote_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size BIGINT,
      modify_time BIGINT,
      sha256 TEXT,
      rows_count INTEGER NOT NULL DEFAULT 0,
      raw_local_path TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS samata_fast_trading_summaries (
      trade_date DATE NOT NULL,
      user_id TEXT NOT NULL,
      counter_party_short_name TEXT NOT NULL,
      pos_num INTEGER NOT NULL DEFAULT 0,
      trade_num INTEGER NOT NULL DEFAULT 0,
      notional_t_minus_1 DOUBLE PRECISION NOT NULL DEFAULT 0,
      notional_ft_t DOUBLE PRECISION NOT NULL DEFAULT 0,
      notional_ft_short_t DOUBLE PRECISION NOT NULL DEFAULT 0,
      trade_amt DOUBLE PRECISION NOT NULL DEFAULT 0,
      trade_amt_ft DOUBLE PRECISION NOT NULL DEFAULT 0,
      trade_amt_ft_short DOUBLE PRECISION NOT NULL DEFAULT 0,
      ft_net DOUBLE PRECISION NOT NULL DEFAULT 0,
      ft_net_short DOUBLE PRECISION NOT NULL DEFAULT 0,
      is_ft TEXT NOT NULL DEFAULT '',
      source_update_time TIMESTAMPTZ,
      source_file_name TEXT NOT NULL,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (trade_date, user_id)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS idx_samata_fast_trading_summaries_trade_date ON samata_fast_trading_summaries (trade_date DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_samata_fast_trading_summaries_user_id ON samata_fast_trading_summaries (user_id)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_samata_fast_trading_summaries_counter_party ON samata_fast_trading_summaries (counter_party_short_name)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_samata_fast_trading_summaries_is_ft ON samata_fast_trading_summaries (is_ft)');
}

function toSummaryRow(row) {
  const tradeDate = normalizeDate(row.trade_dt, 'trade_dt');
  const userId = String(row.user_id ?? '').trim();
  const counterParty = String(row.counter_party ?? '').trim();
  if (!userId || !counterParty) return null;
  const ftNet = numberOrZero(row.ft_net);
  return {
    tradeDate,
    userId,
    counterParty,
    posNum: intOrZero(row.pos_num),
    tradeNum: intOrZero(row.trade_num),
    notionalTMinus1: numberOrZero(row.notional_t_1),
    notionalFtT: numberOrZero(row.notional_ft_t_1) + ftNet,
    notionalFtShortT: numberOrZero(row.notional_ft_short_t),
    tradeAmt: numberOrZero(row.trade_amt),
    tradeAmtFt: numberOrZero(row.trade_amt_ft),
    tradeAmtFtShort: numberOrZero(row.trade_amt_ft_short),
    ftNet,
    ftNetShort: numberOrZero(row.ft_net_short),
    isFt: normalizeIsFt(row.is_ft),
    updateTime: normalizeTimestamp(row.update_time),
    raw: row,
  };
}

async function upsertRows(client, rows, dateCounts) {
  let upserted = 0;
  for (const row of rows) {
    await client.query(
      `
      INSERT INTO samata_fast_trading_summaries (
        trade_date, user_id, counter_party_short_name,
        pos_num, trade_num,
        notional_t_minus_1, notional_ft_t, notional_ft_short_t,
        trade_amt, trade_amt_ft, trade_amt_ft_short,
        ft_net, ft_net_short, is_ft,
        source_update_time, source_file_name, raw
      )
      VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz, $16, $17::jsonb)
      ON CONFLICT (trade_date, user_id)
      DO UPDATE SET
        counter_party_short_name = EXCLUDED.counter_party_short_name,
        pos_num = EXCLUDED.pos_num,
        trade_num = EXCLUDED.trade_num,
        notional_t_minus_1 = EXCLUDED.notional_t_minus_1,
        notional_ft_t = EXCLUDED.notional_ft_t,
        notional_ft_short_t = EXCLUDED.notional_ft_short_t,
        trade_amt = EXCLUDED.trade_amt,
        trade_amt_ft = EXCLUDED.trade_amt_ft,
        trade_amt_ft_short = EXCLUDED.trade_amt_ft_short,
        ft_net = EXCLUDED.ft_net,
        ft_net_short = EXCLUDED.ft_net_short,
        is_ft = EXCLUDED.is_ft,
        source_update_time = EXCLUDED.source_update_time,
        source_file_name = EXCLUDED.source_file_name,
        raw = EXCLUDED.raw,
        updated_at = NOW()
      `,
      [
        pgDate(row.tradeDate),
        row.userId,
        row.counterParty,
        row.posNum,
        row.tradeNum,
        row.notionalTMinus1,
        row.notionalFtT,
        row.notionalFtShortT,
        row.tradeAmt,
        row.tradeAmtFt,
        row.tradeAmtFtShort,
        row.ftNet,
        row.ftNetShort,
        row.isFt,
        row.updateTime,
        'influxdb:north_info',
        JSON.stringify(row.raw),
      ],
    );
    upserted += 1;
  }

  for (const [tradeDate, rowsCount] of dateCounts) {
    await client.query(
      `
      INSERT INTO samata_fast_trading_summary_files (
        trade_date, remote_path, file_name, file_size,
        modify_time, sha256, rows_count, raw_local_path, synced_at
      )
      VALUES ($1::date, $2, $3, NULL, NULL, NULL, $4, NULL, NOW())
      ON CONFLICT (trade_date)
      DO UPDATE SET
        remote_path = EXCLUDED.remote_path,
        file_name = EXCLUDED.file_name,
        rows_count = EXCLUDED.rows_count,
        synced_at = EXCLUDED.synced_at
      `,
      [
        pgDate(tradeDate),
        `influxdb://${process.env.INFLUX_DATABASE ?? 'otchk'}/north_info/${tradeDate}`,
        `north_info-${tradeDate}`,
        rowsCount,
      ],
    );
  }

  return upserted;
}

async function main() {
  const bounds = await detectDateBounds();
  const dateFrom = normalizeDate(argValue('--date-from') ?? bounds.dateFrom, 'date_from');
  const dateTo = normalizeDate(argValue('--date-to') ?? bounds.dateTo, 'date_to');
  if (dateFrom > dateTo) throw new Error('date_from cannot be later than date_to');

  const months = enumerateMonths(dateFrom, dateTo);
  console.log(JSON.stringify({ event: 'start', date_from: dateFrom, date_to: dateTo, months: months.length }));

  const client = createPgClient();
  await client.connect();
  await ensureTables(client);

  let fetched = 0;
  let valid = 0;
  let upserted = 0;
  let skipped = 0;
  const warnings = [];

  try {
    for (const month of months) {
      const influxRows = await queryInflux(`SELECT * FROM "north_info" WHERE "trade_dt" =~ /^${month}/ ORDER BY time ASC LIMIT ${INFLUX_LIMIT}`);
      if (influxRows.length >= INFLUX_LIMIT) warnings.push(`month ${month} reached limit ${INFLUX_LIMIT}`);
      fetched += influxRows.length;

      const rows = [];
      const seenKeys = new Set();
      const duplicateKeys = new Set();
      const dateCounts = new Map();
      for (const raw of influxRows) {
        const tradeDt = raw.trade_dt ? normalizeDate(raw.trade_dt, 'trade_dt') : '';
        if (!tradeDt || tradeDt < dateFrom || tradeDt > dateTo) continue;
        const row = toSummaryRow(raw);
        if (!row) {
          skipped += 1;
          continue;
        }
        const key = `${row.tradeDate}|${row.userId}`;
        if (seenKeys.has(key)) duplicateKeys.add(key);
        seenKeys.add(key);
        rows.push(row);
        dateCounts.set(row.tradeDate, (dateCounts.get(row.tradeDate) ?? 0) + 1);
      }

      await client.query('BEGIN');
      try {
        const monthUpserted = await upsertRows(client, rows, dateCounts);
        await client.query('COMMIT');
        valid += rows.length;
        upserted += monthUpserted;
        console.log(JSON.stringify({
          event: 'month',
          month,
          fetched: influxRows.length,
          valid: rows.length,
          upserted: monthUpserted,
          dates: dateCounts.size,
          duplicate_keys: duplicateKeys.size,
        }));
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    const summary = await client.query(`
      SELECT
        COUNT(*)::text AS rows,
        MIN(trade_date)::text AS min_date,
        MAX(trade_date)::text AS max_date,
        COUNT(DISTINCT trade_date)::text AS dates
      FROM samata_fast_trading_summaries
    `);
    const files = await client.query('SELECT COUNT(*)::text AS files FROM samata_fast_trading_summary_files');
    console.log(JSON.stringify({
      event: 'done',
      fetched,
      valid,
      upserted,
      skipped,
      warnings,
      postgres: {
        rows: summary.rows[0].rows,
        dates: summary.rows[0].dates,
        min_date: summary.rows[0].min_date,
        max_date: summary.rows[0].max_date,
        files: files.rows[0].files,
      },
    }));
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'error', error: err.message }));
  process.exitCode = 1;
});
