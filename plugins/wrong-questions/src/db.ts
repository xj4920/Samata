import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

let db: Database.Database | null = null;

export function getWrongQuestionsDb(dataDir: string): Database.Database {
  if (db) return db;

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'wrong-questions.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS wrong_questions (
      id                 TEXT PRIMARY KEY,
      agent_id           TEXT NOT NULL,
      user_id            TEXT NOT NULL,
      subject            TEXT NOT NULL CHECK(subject IN ('math', 'chinese', 'english', 'science')),
      question_summary   TEXT NOT NULL,
      wrong_answer       TEXT,
      expected_direction TEXT,
      error_type         TEXT NOT NULL DEFAULT 'knowledge' CHECK(error_type IN ('knowledge', 'logic')),
      error_subtype      TEXT,
      analysis           TEXT,
      status             TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'mastered')),
      mistake_count      INTEGER NOT NULL DEFAULT 1,
      source_type        TEXT NOT NULL DEFAULT 'text' CHECK(source_type IN ('text', 'image', 'document')),
      storage_dir        TEXT,
      created_by         TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      last_wrong_at      TEXT NOT NULL DEFAULT (datetime('now')),
      mastered_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS wrong_question_assets (
      id                TEXT PRIMARY KEY,
      wrong_question_id TEXT NOT NULL REFERENCES wrong_questions(id) ON DELETE CASCADE,
      asset_role        TEXT NOT NULL DEFAULT 'original'
                          CHECK(asset_role IN ('original', 'annotated', 'cropped', 'ocr')),
      file_name         TEXT NOT NULL,
      file_ext          TEXT,
      mime_type         TEXT,
      size_bytes        INTEGER,
      stored_path       TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wrong_questions_agent_user_status
      ON wrong_questions(agent_id, user_id, status);
    CREATE INDEX IF NOT EXISTS idx_wrong_questions_agent_user_subject
      ON wrong_questions(agent_id, user_id, subject);
    CREATE INDEX IF NOT EXISTS idx_wrong_question_assets_question_role
      ON wrong_question_assets(wrong_question_id, asset_role);
  `);

  return db;
}

export function closeWrongQuestionsDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
