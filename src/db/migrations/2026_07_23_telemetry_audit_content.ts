import type { MigrationContext } from '../migrate.js';

const COLUMNS: Array<{ name: string; sql: string }> = [
  { name: 'user_question_content', sql: "TEXT NOT NULL DEFAULT ''" },
  { name: 'answer_content', sql: "TEXT NOT NULL DEFAULT ''" },
  { name: 'user_question_chars', sql: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'answer_chars', sql: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'user_question_truncated', sql: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'answer_truncated', sql: 'INTEGER NOT NULL DEFAULT 0' },
];

export async function up({ db }: MigrationContext): Promise<void> {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_turn'",
  ).get();
  if (!table) return;

  const existing = new Set(
    (db.prepare('PRAGMA table_info(telemetry_turn)').all() as Array<{ name: string }>)
      .map(column => column.name),
  );

  for (const column of COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE telemetry_turn ADD COLUMN ${column.name} ${column.sql}`);
    }
  }

  db.exec(`
    UPDATE telemetry_turn
    SET user_question_content = user_question,
        answer_content = answer_preview,
        user_question_chars = length(user_question),
        answer_chars = length(answer_preview)
    WHERE user_question_content = '' AND answer_content = ''
  `);
}

export async function down(): Promise<void> {
  // SQLite cannot drop columns safely across all supported runtime versions.
  // Keeping audit columns is backward compatible with older application code.
}
