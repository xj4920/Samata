import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/samata.db');
const LEGACY_DB_PATH = path.resolve(__dirname, '../../data/yanyu.db');

function migrateDbFile(): void {
  if (fs.existsSync(DB_PATH) || !fs.existsSync(LEGACY_DB_PATH)) return;
  for (const suffix of ['', '-shm', '-wal']) {
    const src = LEGACY_DB_PATH + suffix;
    if (fs.existsSync(src)) fs.renameSync(src, DB_PATH + suffix);
  }
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    migrateDbFile();
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
