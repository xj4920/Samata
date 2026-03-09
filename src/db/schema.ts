import { getDb } from './connection.js';

export function initSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE,
      role       TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      contact      TEXT,
      state        TEXT NOT NULL DEFAULT 'initial_contact'
                   CHECK(state IN (
                     'initial_contact',
                     'requirement_discussion',
                     'solution_design',
                     'uat',
                     'prod'
                   )),
      wework_group TEXT,
      requirements TEXT,
      sales        TEXT,
      tags         TEXT,
      notes        TEXT,
      created_by   TEXT NOT NULL REFERENCES users(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      action      TEXT NOT NULL,
      payload     TEXT,
      performed_by TEXT NOT NULL REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      id           TEXT PRIMARY KEY,
      question     TEXT NOT NULL,
      answer       TEXT NOT NULL,
      tags         TEXT,
      related_users TEXT,
      created_by   TEXT NOT NULL REFERENCES users(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skills (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      prompt     TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: Add related_users and updated_at columns to knowledge table if they don't exist
  try {
    db.exec("ALTER TABLE knowledge ADD COLUMN related_users TEXT");
  } catch (e) {
    // Column may already exist, ignore
  }
  try {
    db.exec("ALTER TABLE knowledge ADD COLUMN updated_at TEXT");
  } catch (e) {
    // Column may already exist, ignore
  }
  // Update existing rows to set updated_at = created_at if null
  db.prepare("UPDATE knowledge SET updated_at = created_at WHERE updated_at IS NULL").run();

  // Migration: Add unique index on knowledge.question
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_question ON knowledge(question)");
  } catch (e) {
    // Index may already exist, ignore
  }

  // Seed default users if empty
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
  if (count.c === 0) {
    const insert = db.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)');
    insert.run('admin-001', 'admin', 'admin');
    insert.run('user-001', 'user', 'user');
  }
}
