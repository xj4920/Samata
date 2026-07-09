import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const DEFAULT_INCLUDE_DIRS = ['documents', 'wiki', 'plugins', 'dreams'];

interface Options {
  source: string;
  output: string;
  manifest: string;
  include: string[];
}

interface SnapshotStats {
  directories: number;
  files: number;
  copiedFiles: number;
  sqliteBackups: string[];
  sqliteFallbackCopies: Array<{ path: string; reason: string }>;
  skippedSidecars: string[];
  skippedSymlinks: string[];
  bytes: number;
}

function parseArgs(argv: string[]): Options {
  const output = process.env.SAMATA_BASELINE_DATA_OUTPUT ?? 'docker-baseline/data-files.tar.gz';
  const options: Options = {
    source: process.env.SAMATA_BASELINE_DATA_SOURCE ?? '/opt/samata/data',
    output,
    manifest: process.env.SAMATA_BASELINE_DATA_MANIFEST ?? 'docker-baseline/data-files.manifest.json',
    include: [...DEFAULT_INCLUDE_DIRS],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      options.source = argv[++index] ?? '';
    } else if (arg === '--output' || arg === '--out') {
      options.output = argv[++index] ?? '';
    } else if (arg === '--manifest') {
      options.manifest = argv[++index] ?? '';
    } else if (arg === '--include') {
      options.include = (argv[++index] ?? '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.source) throw new Error('Missing --source');
  if (!options.output) throw new Error('Missing --output');
  if (!options.manifest) throw new Error('Missing --manifest');
  if (options.include.length === 0) throw new Error('Missing --include entries');
  for (const entry of options.include) {
    if (entry.includes('/') || entry.includes('\\') || entry === '.' || entry === '..') {
      throw new Error(`Include entries must be top-level directory names: ${entry}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/prepare-data-files-baseline.ts [--source <data_dir>] [--output <tar.gz>] [--manifest <json>]

Defaults:
  --source /opt/samata/data
  --output docker-baseline/data-files.tar.gz
  --manifest docker-baseline/data-files.manifest.json
  --include documents,wiki,plugins,dreams

The output archive contains agent file data that should stay in sync with the
SQLite baseline. SQLite files inside plugin data are copied through the SQLite
backup API when possible; WAL/SHM sidecars are not archived.`);
}

function createEmptyStats(): SnapshotStats {
  return {
    directories: 0,
    files: 0,
    copiedFiles: 0,
    sqliteBackups: [],
    sqliteFallbackCopies: [],
    skippedSidecars: [],
    skippedSymlinks: [],
    bytes: 0,
  };
}

function isSqliteMainFile(filePath: string): boolean {
  return /\.(db|sqlite|sqlite3)$/i.test(filePath);
}

function isSqliteSidecar(filePath: string): boolean {
  return /\.(db|sqlite|sqlite3)-(wal|shm)$/i.test(filePath);
}

function displayPath(sourceRoot: string, filePath: string): string {
  return relative(sourceRoot, filePath).split('\\').join('/');
}

function removeStaleTempOutputs(outputDir: string): void {
  for (const entry of readdirSync(outputDir)) {
    if (
      entry.startsWith('data-files.tar.gz.tmp-') ||
      entry.startsWith('data-files.manifest.json.tmp-') ||
      entry.startsWith('.data-files-staging-')
    ) {
      rmSync(resolve(outputDir, entry), { recursive: true, force: true });
    }
  }
}

function checkDatabase(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (row?.quick_check !== 'ok') {
      throw new Error(`SQLite quick_check failed: ${row?.quick_check ?? 'unknown'}`);
    }
  } finally {
    db.close();
  }
}

async function tryBackupSqlite(sourcePath: string, targetPath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let db: Database.Database | undefined;
  try {
    db = new Database(sourcePath, { readonly: true, fileMustExist: true });
    await db.backup(targetPath);
    checkDatabase(targetPath);
    rmSync(`${targetPath}-wal`, { force: true });
    rmSync(`${targetPath}-shm`, { force: true });
    return { ok: true };
  } catch (error) {
    rmSync(targetPath, { force: true });
    rmSync(`${targetPath}-wal`, { force: true });
    rmSync(`${targetPath}-shm`, { force: true });
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

async function snapshotEntry(sourceRoot: string, sourcePath: string, targetPath: string, stats: SnapshotStats): Promise<void> {
  const sourceStat = lstatSync(sourcePath);
  const relativePath = displayPath(sourceRoot, sourcePath);

  if (sourceStat.isSymbolicLink()) {
    stats.skippedSymlinks.push(relativePath);
    return;
  }

  if (sourceStat.isDirectory()) {
    mkdirSync(targetPath, { recursive: true });
    stats.directories += 1;
    for (const entry of readdirSync(sourcePath).sort()) {
      await snapshotEntry(sourceRoot, join(sourcePath, entry), join(targetPath, entry), stats);
    }
    return;
  }

  if (!sourceStat.isFile()) {
    return;
  }

  if (isSqliteSidecar(sourcePath)) {
    stats.skippedSidecars.push(relativePath);
    return;
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  if (isSqliteMainFile(sourcePath)) {
    const backupResult = await tryBackupSqlite(sourcePath, targetPath);
    if (backupResult.ok) {
      const size = statSync(targetPath).size;
      stats.files += 1;
      stats.bytes += size;
      stats.sqliteBackups.push(relativePath);
      return;
    }
    stats.sqliteFallbackCopies.push({ path: relativePath, reason: backupResult.reason });
  }

  copyFileSync(sourcePath, targetPath);
  stats.files += 1;
  stats.copiedFiles += 1;
  stats.bytes += statSync(targetPath).size;
}

function runTar(stagingDir: string, outputPath: string): void {
  const result = spawnSync('tar', ['-czf', outputPath, '-C', stagingDir, '.'], {
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tar exited with status ${result.status ?? 'unknown'}`);
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const source = resolve(options.source);
  const output = resolve(options.output);
  const manifestPath = resolve(options.manifest);
  const outputDir = dirname(output);
  const tempOutput = join(outputDir, `${basename(output)}.tmp-${process.pid}`);
  const tempManifest = join(dirname(manifestPath), `${basename(manifestPath)}.tmp-${process.pid}`);
  const stagingDir = join(outputDir, `.data-files-staging-${process.pid}`);

  if (!existsSync(source)) throw new Error(`Source data directory not found: ${source}`);
  if (!statSync(source).isDirectory()) throw new Error(`Source is not a directory: ${source}`);

  mkdirSync(outputDir, { recursive: true });
  mkdirSync(dirname(manifestPath), { recursive: true });
  removeStaleTempOutputs(outputDir);
  rmSync(tempOutput, { force: true });
  rmSync(tempManifest, { force: true });
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const stats = createEmptyStats();
  const included: Array<{ name: string; exists: boolean }> = [];

  try {
    for (const name of options.include) {
      const sourcePath = join(source, name);
      included.push({ name, exists: existsSync(sourcePath) });
      if (!existsSync(sourcePath)) continue;
      await snapshotEntry(source, sourcePath, join(stagingDir, name), stats);
    }

    runTar(stagingDir, tempOutput);
    const archiveSize = statSync(tempOutput).size;
    const archiveSha256 = await hashFile(tempOutput);
    renameSync(tempOutput, output);

    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source,
      output,
      include: included,
      archive: {
        size: archiveSize,
        sha256: archiveSha256,
      },
      stats,
    };

    writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(tempManifest, manifestPath);

    console.log(`Data files baseline refreshed: ${output} (${archiveSize} bytes, sha256 ${archiveSha256})`);
    console.log(`Manifest written: ${manifestPath}`);
  } finally {
    rmSync(tempOutput, { force: true });
    rmSync(tempManifest, { force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
