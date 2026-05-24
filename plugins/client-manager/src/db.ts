import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

let db: Database.Database | null = null;

export function getClientDb(dataDir: string): Database.Database {
  if (db) return db;

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'client-manager.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      contact               TEXT,
      state                 TEXT NOT NULL DEFAULT 'initial_contact',
      wework_group          TEXT,
      requirements          TEXT,
      sales                 TEXT,
      tags                  TEXT,
      notes                 TEXT,
      long_financing_spread REAL,
      short_financing       REAL,
      commission            REAL,
      commission_cost       REAL,
      net_comm              REAL,
      index_hedging         INTEGER,
      pricing_range         TEXT,
      is_ft                 INTEGER NOT NULL DEFAULT 0,
      created_by            TEXT NOT NULL,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS client_events (
      id                TEXT PRIMARY KEY,
      client_id         TEXT NOT NULL,
      action            TEXT NOT NULL,
      payload           TEXT,
      performed_by      TEXT NOT NULL,
      performed_by_name TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_client_events_client_id
      ON client_events(client_id);
  `);

  return db;
}

export function closeClientDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('client-manager plugin DB not initialized');
  return db;
}
