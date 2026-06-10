import type Database from 'better-sqlite3';
import type { UmzugStorage } from 'umzug';

export function sqliteMigrationStorage(db: Database.Database): UmzugStorage {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return {
    async executed() {
      const rows = db
        .prepare('SELECT id FROM migrations ORDER BY applied_at ASC, id ASC')
        .all() as Array<{ id: string }>;
      return rows.map(row => row.id);
    },
    async logMigration({ name }) {
      db.prepare('INSERT OR IGNORE INTO migrations (id) VALUES (?)').run(name);
    },
    async unlogMigration({ name }) {
      db.prepare('DELETE FROM migrations WHERE id = ?').run(name);
    },
  };
}
