import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { setupUnitDb, teardownDb, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('Umzug migration runner', () => {
  let ctx: UnitTestContext | null = null;
  let standaloneDb: Database.Database | null = null;
  let tempDir: string | null = null;

  afterEach(() => {
    if (ctx) {
      teardownDb();
      ctx = null;
    }
    try { standaloneDb?.close(); } catch {}
    standaloneDb = null;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('records discovered migrations in the existing migrations table', async () => {
    ctx = await setupUnitDb();
    tempDir = mkdtempSync(join(tmpdir(), 'samata-migration-test-'));
    const migrationName = 'unit_test_migration';
    writeFileSync(
      join(tempDir, `${migrationName}.js`),
      `
export async function up({ db }) {
  db.exec("CREATE TABLE IF NOT EXISTS unit_migration_marker (id TEXT PRIMARY KEY)");
  db.prepare("INSERT OR IGNORE INTO unit_migration_marker (id) VALUES (?)").run("ran");
}
`,
    );

    const { createMigrator } = await import('../../../src/db/migrate.js');
    await createMigrator({ db: ctx.db, migrationsGlob: join(tempDir, '*.js') }).up();

    const migration = ctx.db.prepare('SELECT id FROM migrations WHERE id = ?').get(migrationName) as { id: string } | undefined;
    const marker = ctx.db.prepare('SELECT id FROM unit_migration_marker WHERE id = ?').get('ran') as { id: string } | undefined;
    expect(migration?.id).toBe(migrationName);
    expect(marker?.id).toBe('ran');
  });

  it('running initDatabase again does not duplicate migration rows', async () => {
    ctx = await setupUnitDb();
    const before = ctx.db.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number };

    const { initDatabase } = await import('../../../src/db/schema.js');
    await initDatabase();

    const after = ctx.db.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it('sqliteMigrationStorage logs and unlogs migration ids', async () => {
    standaloneDb = new Database(':memory:');
    const { sqliteMigrationStorage } = await import('../../../src/db/migration-storage.js');
    const storage = sqliteMigrationStorage(standaloneDb);

    await storage.logMigration({ name: 'unit-storage-smoke', path: undefined, context: {} });
    expect(await storage.executed()).toContain('unit-storage-smoke');

    await storage.unlogMigration({ name: 'unit-storage-smoke', path: undefined, context: {} });
    expect(await storage.executed()).not.toContain('unit-storage-smoke');
  });

  it('widens legacy scheduled_tasks CHECK constraint for agent_chat', async () => {
    standaloneDb = new Database(':memory:');
    standaloneDb.exec(`
      CREATE TABLE scheduled_tasks (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        cron_expr   TEXT NOT NULL,
        task_type   TEXT NOT NULL CHECK(task_type IN ('remind', 'sandbox_exec', 'tool_call')),
        payload     TEXT NOT NULL,
        channel     TEXT NOT NULL,
        target_id   TEXT,
        app_id      TEXT,
        enabled     INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_result TEXT,
        created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        created_by  TEXT
      );
      INSERT INTO scheduled_tasks (
        id, agent_id, name, cron_expr, task_type, payload, channel, created_by
      ) VALUES (
        'legacy-reminder', 'agent-otcclaw', 'legacy remind', '30 8 * * 1-5',
        'remind', '{"message":"早报"}', 'wework', 'admin-001'
      );
    `);

    const { runMigrations } = await import('../../../src/db/migrate.js');
    await runMigrations({ db: standaloneDb });

    const table = standaloneDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_tasks'",
    ).get() as { sql: string };
    expect(table.sql).toContain("'agent_chat'");

    const columns = standaloneDb.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>;
    expect(columns.map(column => column.name)).toContain('locked_until');

    const legacy = standaloneDb.prepare(
      'SELECT id, task_type, created_by FROM scheduled_tasks WHERE id = ?',
    ).get('legacy-reminder') as { id: string; task_type: string; created_by: string };
    expect(legacy).toEqual({ id: 'legacy-reminder', task_type: 'remind', created_by: 'admin-001' });

    expect(() => standaloneDb!.prepare(`
      INSERT INTO scheduled_tasks (
        id, agent_id, name, cron_expr, task_type, payload, channel
      ) VALUES (
        'agent-chat-task', 'agent-otcclaw', '每日公司行为提醒', '30 8 * * 2-6',
        'agent_chat', '{"prompt":"同步公司行为"}', 'wework'
      )
    `).run()).not.toThrow();
  });
});
