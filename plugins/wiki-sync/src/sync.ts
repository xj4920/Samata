/**
 * sync.ts — Confluence 同步：cf-export + lockfile 对比 + 增量导入
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { importPages, type SamataConfig } from './import-bridge.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncConfig {
  confluence: {
    url: string;
    username: string;
    api_token: string;
  };
  samata: SamataConfig;
  sync: {
    output_path: string;
    spaces: string[];
    pages?: string[];
    page_mode?: 'page' | 'descendants';
  };
  cron: {
    schedule: string;
  };
  cf_export: {
    workers: number;
    cleanup_stale: boolean;
  };
}

interface LockEntry {
  version: number;
  title?: string;
  export_path?: string;
}

interface Lockfile {
  [page_id: string]: LockEntry;
}

interface SnapshotPage {
  version: number;
  document_id: string;
  title: string;
  imported_at: string;
}

interface Snapshot {
  last_run: string;
  pages: Record<string, SnapshotPage>;
}

// ---------------------------------------------------------------------------
// cf-export runner
// ---------------------------------------------------------------------------

interface CfExportTarget {
  mode: 'spaces' | 'pages' | 'pages-with-descendants';
  targets: string[];
}

function getCfExportTarget(config: SyncConfig, cliPages?: string[], cliDescendants?: boolean): CfExportTarget {
  if (cliPages && cliPages.length > 0) {
    return {
      mode: cliDescendants ? 'pages-with-descendants' : 'pages',
      targets: cliPages,
    };
  }

  if (config.sync.pages && config.sync.pages.length > 0) {
    const mode = config.sync.page_mode === 'descendants' ? 'pages-with-descendants' : 'pages';
    return { mode, targets: config.sync.pages };
  }

  if (config.sync.spaces && config.sync.spaces.length > 0) {
    return { mode: 'spaces', targets: config.sync.spaces };
  }

  throw new Error('未配置 sync.spaces 或 sync.pages，请至少指定一个同步来源');
}

function runCfExport(config: SyncConfig, target: CfExportTarget): void {
  const args = [target.mode, ...target.targets, '--output-path', config.sync.output_path];

  const env = {
    ...process.env,
    CONFLUENCE_URL: config.confluence.url,
    CONFLUENCE_USERNAME: config.confluence.username,
    CONFLUENCE_API_TOKEN: config.confluence.api_token,
    CF_EXPORT_WORKERS: String(config.cf_export.workers),
    http_proxy: '',
    https_proxy: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    no_proxy: '*.gf.com.cn',
    NO_PROXY: '*.gf.com.cn',
  };

  if (config.cf_export.cleanup_stale) {
    args.push('--cleanup-stale');
  }

  console.log(`[cf-export] 模式: ${target.mode}, 目标: ${target.targets.join(', ')}`);
  execFileSync('cf-export', args, { env, stdio: 'inherit' });
  console.log('[cf-export] 导出完成');
}

// ---------------------------------------------------------------------------
// Lockfile handling
// ---------------------------------------------------------------------------

function findLockfile(outputPath: string): string | null {
  const candidates = [
    path.join(outputPath, 'confluence-lock.json'),
    path.join(outputPath, 'lockfile.json'),
    path.join(outputPath, '..', 'confluence-lock.json'),
    path.join(outputPath, '..', 'lockfile.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return findFileRecursive(outputPath, 'confluence-lock.json', 2)
    || findFileRecursive(outputPath, 'lockfile.json', 2);
}

function isDirectory(entry: fs.Dirent, parentDir: string): boolean {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    try { return fs.statSync(path.join(parentDir, entry.name)).isDirectory(); } catch { return false; }
  }
  return false;
}

function findFileRecursive(dir: string, filename: string, maxDepth: number): string | null {
  if (maxDepth < 0 || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name === filename) return path.join(dir, e.name);
    if (isDirectory(e, dir) && !e.name.startsWith('.')) {
      const found = findFileRecursive(path.join(dir, e.name), filename, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

function readLockfile(filePath: string): Lockfile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  return data.pages ?? data;
}

// ---------------------------------------------------------------------------
// Snapshot handling
// ---------------------------------------------------------------------------

function loadSnapshot(snapshotPath: string): Snapshot {
  try {
    if (fs.existsSync(snapshotPath)) {
      return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    }
  } catch { /* corrupted, treat as empty */ }
  return { last_run: '', pages: {} };
}

function saveSnapshot(snapshotPath: string, snapshot: Snapshot): void {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Page discovery
// ---------------------------------------------------------------------------

interface DiscoveredPage {
  mdPath: string;
  pageId: string;
  title: string;
}

function parsePageIdFromMd(mdPath: string): string | null {
  try {
    const content = fs.readFileSync(mdPath, 'utf-8');
    if (!content.startsWith('---\n')) return null;
    const endIdx = content.indexOf('\n---', 4);
    if (endIdx === -1) return null;
    const fm = yaml.parse(content.slice(4, endIdx)) as Record<string, unknown> | null;
    const cpi = fm?.confluence_page_id;
    return cpi != null ? String(cpi) : null;
  } catch {
    return null;
  }
}

function discoverPages(outputPath: string): DiscoveredPage[] {
  const pages: DiscoveredPage[] = [];

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (isDirectory(e, dir) && !e.name.startsWith('.') && e.name !== 'images' && e.name !== 'attachments') {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const pageId = parsePageIdFromMd(full);
        if (pageId) {
          pages.push({ mdPath: full, pageId, title: path.basename(full, '.md') });
        }
      }
    }
  }

  walk(outputPath);
  return pages;
}

// ---------------------------------------------------------------------------
// Diff logic
// ---------------------------------------------------------------------------

interface DiffResult {
  newPages: Array<{ mdPath: string; pageId: string; version: number }>;
  updatedPages: Array<{ mdPath: string; pageId: string; version: number; oldDocumentId: string }>;
  deletedPages: Array<{ pageId: string; documentId: string; title: string }>;
  skippedCount: number;
}

function diffLockfile(lockfile: Lockfile, snapshot: Snapshot, pages: DiscoveredPage[]): DiffResult {
  const result: DiffResult = { newPages: [], updatedPages: [], deletedPages: [], skippedCount: 0 };

  const lockKeys = new Set(Object.keys(lockfile));
  const snapKeys = new Set(Object.keys(snapshot.pages));

  const pageByPageId = new Map<string, DiscoveredPage>();
  for (const p of pages) {
    if (pageByPageId.has(p.pageId)) continue;
    pageByPageId.set(p.pageId, p);
  }

  for (const [pageId, lockEntry] of Object.entries(lockfile)) {
    const page = pageByPageId.get(pageId);
    if (!page) continue;

    if (!snapKeys.has(pageId)) {
      result.newPages.push({ mdPath: page.mdPath, pageId, version: lockEntry.version });
    } else if (snapshot.pages[pageId].version !== lockEntry.version) {
      result.updatedPages.push({
        mdPath: page.mdPath,
        pageId,
        version: lockEntry.version,
        oldDocumentId: snapshot.pages[pageId].document_id,
      });
    } else {
      result.skippedCount++;
    }
  }

  for (const pageId of snapKeys) {
    if (!lockKeys.has(pageId)) {
      result.deletedPages.push({
        pageId,
        documentId: snapshot.pages[pageId].document_id,
        title: snapshot.pages[pageId].title,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main sync logic
// ---------------------------------------------------------------------------

export async function runSync(config: SyncConfig, fullSync: boolean = false, cliPages?: string[], cliDescendants?: boolean): Promise<void> {
  console.log('=== Wiki Sync 开始 ===');
  console.log(`模式: ${fullSync ? '全量' : '增量'}`);
  console.log(`时间: ${new Date().toISOString()}`);

  const target = getCfExportTarget(config, cliPages, cliDescendants);
  const outputPath = path.resolve(config.sync.output_path);
  const snapshotPath = path.join(path.dirname(outputPath), 'snapshot.json');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      runCfExport(config, target);
      break;
    } catch (e: any) {
      if (attempt < 3) {
        const delayMs = 300_000 * attempt;
        console.error(`[cf-export] 失败 (${attempt}/3), ${delayMs / 1000}s 后重试: ${e.message}`);
        await sleep(delayMs);
      } else {
        console.error(`[cf-export] 3次重试均失败: ${e.message}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  const lockfilePath = findLockfile(outputPath);
  if (!lockfilePath) {
    console.error('[错误] 未找到 lockfile.json，cf-export 可能未正确运行');
    process.exitCode = 1;
    return;
  }
  console.log(`[lockfile] ${lockfilePath}`);

  const lockfile = readLockfile(lockfilePath);
  const snapshot = fullSync ? { last_run: '', pages: {} } : loadSnapshot(snapshotPath);
  const pages = discoverPages(outputPath);
  console.log(`[发现] ${pages.length} 个 .md 文件, lockfile 中有 ${Object.keys(lockfile).length} 个页面`);

  const diff = diffLockfile(lockfile, snapshot, pages);
  console.log(`[diff] 新增: ${diff.newPages.length}, 更新: ${diff.updatedPages.length}, 删除: ${diff.deletedPages.length}, 跳过: ${diff.skippedCount}`);

  const allToImport: Array<{ mdPath: string; pageId: string; version: number; oldDocumentId?: string }> = [
    ...diff.newPages.map(p => ({ mdPath: p.mdPath, pageId: p.pageId, version: p.version })),
    ...diff.updatedPages.map(p => ({ mdPath: p.mdPath, pageId: p.pageId, version: p.version, oldDocumentId: p.oldDocumentId })),
  ];

  if (allToImport.length > 0) {
    const results = await importPages(config.samata, allToImport, msg => console.log(`  ${msg}`));

    const now = new Date().toISOString();
    for (const r of results) {
      if (r.document_id) {
        snapshot.pages[r.page_id] = {
          version: r.version,
          document_id: r.document_id,
          title: r.title,
          imported_at: now,
        };
      } else if (r.status === 'skipped') {
        const existing = snapshot.pages[r.page_id];
        if (existing) {
          existing.version = r.version;
        }
      }
    }

    for (const d of diff.deletedPages) {
      delete snapshot.pages[d.pageId];
    }

    snapshot.last_run = now;

    const succeeded = results.filter(r => r.status === 'imported' || r.status === 'updated').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const failed = results.filter(r => r.status === 'failed').length;
    console.log(`[导入完成] 成功: ${succeeded}, 跳过: ${skipped}, 失败: ${failed}`);

    if (failed > 0) {
      for (const f of results.filter(r => r.status === 'failed')) {
        console.error(`  失败: [${f.page_id}] ${f.title} - ${f.error}`);
      }
    }
  }

  saveSnapshot(snapshotPath, snapshot);
  console.log(`[snapshot] 已保存 (${Object.keys(snapshot.pages).length} 个页面)`);
  console.log('=== Wiki Sync 完成 ===');
}

// ---------------------------------------------------------------------------
// Export only (no import)
// ---------------------------------------------------------------------------

export async function runExport(config: SyncConfig, cliPages?: string[], cliDescendants?: boolean): Promise<void> {
  console.log('=== Wiki Export ===');
  const target = getCfExportTarget(config, cliPages, cliDescendants);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      runCfExport(config, target);
      console.log('=== Export 完成 ===');
      return;
    } catch (e: any) {
      if (attempt < 3) {
        const delayMs = 300_000 * attempt;
        console.error(`[cf-export] 失败 (${attempt}/3), ${delayMs / 1000}s 后重试: ${e.message}`);
        await sleep(delayMs);
      } else {
        console.error(`[cf-export] 3次重试均失败: ${e.message}`);
        process.exitCode = 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Import only (from existing archive)
// ---------------------------------------------------------------------------

export async function runImportOnly(config: SyncConfig): Promise<void> {
  console.log('=== Wiki Import (仅导入) ===');

  const outputPath = path.resolve(config.sync.output_path);
  const snapshotPath = path.join(path.dirname(outputPath), 'snapshot.json');
  const lockfilePath = findLockfile(outputPath);

  if (!lockfilePath) {
    console.error('[错误] 未找到 lockfile.json，请先执行 cf-export');
    process.exitCode = 1;
    return;
  }

  const lockfile = readLockfile(lockfilePath);
  const snapshot = loadSnapshot(snapshotPath);
  const pages = discoverPages(outputPath);

  const diff = diffLockfile(lockfile, snapshot, pages);
  const allToImport: Array<{ mdPath: string; pageId: string; version: number; oldDocumentId?: string }> = [
    ...diff.newPages.map(p => ({ mdPath: p.mdPath, pageId: p.pageId, version: p.version })),
    ...diff.updatedPages.map(p => ({ mdPath: p.mdPath, pageId: p.pageId, version: p.version, oldDocumentId: p.oldDocumentId })),
  ];

  if (allToImport.length === 0) {
    console.log('所有页面已是最新，无需导入');
    return;
  }

  console.log(`待导入: ${allToImport.length} 个页面`);
  const results = await importPages(config.samata, allToImport, msg => console.log(`  ${msg}`));

  const now = new Date().toISOString();
  let imported = 0, failed = 0;
  for (const r of results) {
    if (r.document_id) {
      snapshot.pages[r.page_id] = { version: r.version, document_id: r.document_id, title: r.title, imported_at: now };
      imported++;
    } else if (r.status === 'failed') {
      failed++;
      console.error(`  失败: [${r.page_id}] ${r.title} - ${r.error}`);
    }
  }
  snapshot.last_run = now;
  saveSnapshot(snapshotPath, snapshot);
  console.log(`成功: ${imported}, 失败: ${failed}`);
  console.log('=== Import 完成 ===');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function showStatus(config: SyncConfig): void {
  const outputPath = path.resolve(config.sync.output_path);
  const snapshotPath = path.join(path.dirname(outputPath), 'snapshot.json');
  const lockfilePath = findLockfile(outputPath);

  console.log('=== Wiki Sync Status ===');
  console.log(`Samata: ${config.samata.base_url}`);
  console.log(`Agent: ${config.samata.agent_name}`);
  console.log(`Spaces: ${config.sync.spaces?.join(', ') || '(未配置)'}`);
  console.log(`输出目录: ${outputPath}`);

  if (lockfilePath) {
    const lockfile = readLockfile(lockfilePath);
    console.log(`lockfile: ${Object.keys(lockfile).length} 个页面`);
  } else {
    console.log('lockfile: 未找到');
  }

  if (fs.existsSync(snapshotPath)) {
    const snapshot = loadSnapshot(snapshotPath);
    console.log(`snapshot: ${Object.keys(snapshot.pages).length} 个页面 (上次: ${snapshot.last_run || '未知'})`);
  } else {
    console.log('snapshot: 未创建');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
