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
});
