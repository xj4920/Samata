import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

interface Options {
  source: string;
  output: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    source: process.env.SAMATA_BASELINE_SOURCE_DB ?? '/opt/samata/data/samata.db',
    output: process.env.SAMATA_BASELINE_OUTPUT_DB ?? 'docker-baseline/samata.db',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      options.source = argv[++index] ?? '';
    } else if (arg === '--output' || arg === '--out') {
      options.output = argv[++index] ?? '';
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.source) throw new Error('Missing --source');
  if (!options.output) throw new Error('Missing --output');
  return options;
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/prepare-sqlite-baseline.ts [--source <db>] [--output <db>]

Defaults:
  --source /opt/samata/data/samata.db
  --output docker-baseline/samata.db

The output database is a consistent SQLite backup. WAL/SHM files are not copied.`);
}

function checkDatabase(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (row?.quick_check !== 'ok') {
      throw new Error(`SQLite quick_check failed for ${dbPath}: ${row?.quick_check ?? 'unknown'}`);
    }
  } finally {
    db.close();
  }
}

function removeSqliteSidecars(dbPath: string): void {
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

function removeStaleTempOutputs(output: string): void {
  const outputDir = dirname(output);
  const tempPrefix = `${basename(output)}.tmp-`;
  for (const entry of readdirSync(outputDir)) {
    if (!entry.startsWith(tempPrefix)) continue;
    rmSync(resolve(outputDir, entry), { force: true });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const source = resolve(options.source);
  const output = resolve(options.output);
  const tempOutput = `${output}.tmp-${process.pid}`;

  if (!existsSync(source)) throw new Error(`Source SQLite database not found: ${source}`);
  if (source === output) throw new Error('Source and output must be different paths');

  mkdirSync(dirname(output), { recursive: true });
  removeStaleTempOutputs(output);
  rmSync(tempOutput, { force: true });
  removeSqliteSidecars(tempOutput);

  checkDatabase(source);

  const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(tempOutput);
    checkDatabase(tempOutput);
    removeSqliteSidecars(tempOutput);
    renameSync(tempOutput, output);
    removeSqliteSidecars(output);
  } finally {
    sourceDb.close();
    rmSync(tempOutput, { force: true });
    removeSqliteSidecars(tempOutput);
    removeStaleTempOutputs(output);
  }

  const size = statSync(output).size;
  console.log(`SQLite baseline refreshed: ${output} (${size} bytes)`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
