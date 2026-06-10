import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { setupUnitDb, teardownDb, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('Umzug migration runner', () => {
  let ctx: UnitTestContext | null = null;
  let standaloneDb: Database.Database | null = null;

  afterEach(() => {
    if (ctx) {
      teardownDb();
      ctx = null;
    }
    try { standaloneDb?.close(); } catch {}
    standaloneDb = null;
  });

  it('records source migrations in the existing migrations table', async () => {
    ctx = await setupUnitDb();

    const row = ctx.db.prepare(
      "SELECT id FROM migrations WHERE id = '20260610_0001_migration_runner_smoke'",
    ).get() as { id: string } | undefined;

    expect(row?.id).toBe('20260610_0001_migration_runner_smoke');
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
});
