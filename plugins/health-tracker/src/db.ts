import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

let db: Database.Database | null = null;

export function getHealthDb(dataDir: string): Database.Database {
  if (db) return db;

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'health-tracker.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS health_records (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      record_type TEXT NOT NULL,
      value       TEXT NOT NULL,
      unit        TEXT,
      measured_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_health_records_user_agent_type
      ON health_records(user_id, agent_id, record_type);
    CREATE INDEX IF NOT EXISTS idx_health_records_measured_at
      ON health_records(measured_at);
  `);

  return db;
}

export function closeHealthDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
