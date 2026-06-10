import type Database from 'better-sqlite3';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Umzug } from 'umzug';
import { closeDb, getDb } from './connection.js';
import { sqliteMigrationStorage } from './migration-storage.js';

export interface MigrationContext {
  db: Database.Database;
}

export interface RunMigrationsOptions {
  db?: Database.Database;
  migrationsGlob?: string;
}

function defaultMigrationsGlob(): string {
  const dbDir = dirname(fileURLToPath(import.meta.url));
  return join(dbDir, 'migrations', '*.{ts,js}');
}

function normalizeMigrationName(name: string): string {
  return basename(name).replace(/\.(?:c|m)?[jt]s$/, '');
}

export function createMigrator(options: RunMigrationsOptions = {}): Umzug<MigrationContext> {
  const db = options.db ?? getDb();
  const context: MigrationContext = { db };

  return new Umzug<MigrationContext>({
    migrations: {
      glob: options.migrationsGlob ?? defaultMigrationsGlob(),
      resolve: ({ name, path: migrationPath, context: migrationContext }) => {
        const migrationName = normalizeMigrationName(name);
        if (!migrationPath) {
          throw new Error(`Migration path is missing for ${migrationName}`);
        }
        const migrationUrl = pathToFileURL(migrationPath).href;

        return {
          name: migrationName,
          up: async () => {
            const mod = await import(migrationUrl);
            if (typeof mod.up !== 'function') {
              throw new Error(`Migration ${migrationName} does not export up()`);
            }
            await mod.up(migrationContext);
          },
          down: async () => {
            const mod = await import(migrationUrl);
            if (typeof mod.down === 'function') {
              await mod.down(migrationContext);
            }
          },
        };
      },
    },
    context,
    storage: sqliteMigrationStorage(db),
    logger: undefined,
  });
}

export async function runMigrations(options: RunMigrationsOptions = {}): Promise<void> {
  await createMigrator(options).up();
}

async function main(): Promise<void> {
  await runMigrations();
  closeDb();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    closeDb();
    process.exit(1);
  });
}
