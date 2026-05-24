import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

let db: Database.Database | null = null;

export function getPricingDb(dataDir: string): Database.Database {
  if (db) return db;

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'pricing.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_quotes (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      quote_type  TEXT NOT NULL,
      quote_date  TEXT NOT NULL,
      file_name   TEXT,
      data        TEXT NOT NULL,
      metadata    TEXT,
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pricing_quotes_agent_type
      ON pricing_quotes(agent_id, quote_type, quote_date);
  `);

  return db;
}

export function closePricingDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('pricing plugin DB not initialized');
  return db;
}
