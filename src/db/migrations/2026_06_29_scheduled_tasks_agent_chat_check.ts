import type { MigrationContext } from '../migrate.js';

const TABLE = 'scheduled_tasks';
const OLD_TABLE = 'scheduled_tasks__agent_chat_check_old';

const FINAL_COLUMNS = [
  'id',
  'agent_id',
  'name',
  'cron_expr',
  'task_type',
  'payload',
  'channel',
  'target_id',
  'app_id',
  'enabled',
  'next_run_at',
  'locked_until',
  'last_run_at',
  'last_result',
  'created_at',
  'created_by',
] as const;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function scheduledTasksSql(tableName = TABLE): string {
  return `
    CREATE TABLE ${quoteIdent(tableName)} (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      name         TEXT NOT NULL,
      cron_expr    TEXT NOT NULL,
      task_type    TEXT NOT NULL CHECK(task_type IN ('remind', 'sandbox_exec', 'tool_call', 'agent_chat')),
      payload      TEXT NOT NULL,
      channel      TEXT NOT NULL,
      target_id    TEXT,
      app_id       TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      next_run_at  INTEGER,
      locked_until INTEGER,
      last_run_at  INTEGER,
      last_result  TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      created_by   TEXT
    )
  `;
}

function fallbackExpression(column: (typeof FINAL_COLUMNS)[number]): string {
  switch (column) {
    case 'enabled':
      return '1';
    case 'created_at':
      return "(strftime('%s','now') * 1000)";
    case 'target_id':
    case 'app_id':
    case 'next_run_at':
    case 'locked_until':
    case 'last_run_at':
    case 'last_result':
    case 'created_by':
      return 'NULL';
    default:
      throw new Error(`scheduled_tasks legacy table is missing required column: ${column}`);
  }
}

export async function up({ db }: MigrationContext): Promise<void> {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(TABLE) as { sql: string } | undefined;

  if (!row) return;
  if (row.sql.includes("'agent_chat'")) return;

  const oldColumns = new Set(
    (db.prepare(`PRAGMA table_info(${quoteIdent(TABLE)})`).all() as Array<{ name: string }>)
      .map(column => column.name),
  );

  const previousForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');

  try {
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${quoteIdent(OLD_TABLE)}`);
      db.exec(`ALTER TABLE ${quoteIdent(TABLE)} RENAME TO ${quoteIdent(OLD_TABLE)}`);
      db.exec(scheduledTasksSql(TABLE));

      const insertColumns = FINAL_COLUMNS.map(quoteIdent).join(', ');
      const selectColumns = FINAL_COLUMNS
        .map(column => oldColumns.has(column) ? quoteIdent(column) : `${fallbackExpression(column)} AS ${quoteIdent(column)}`)
        .join(', ');

      db.exec(`
        INSERT INTO ${quoteIdent(TABLE)} (${insertColumns})
        SELECT ${selectColumns}
        FROM ${quoteIdent(OLD_TABLE)}
      `);
      db.exec(`DROP TABLE ${quoteIdent(OLD_TABLE)}`);
    })();
  } finally {
    db.pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
  }
}

export async function down(): Promise<void> {
  // SQLite cannot narrow a CHECK constraint without another table rebuild. This
  // migration intentionally keeps the forward-compatible scheduled task type.
}
