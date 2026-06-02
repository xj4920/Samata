/**
 * Guard test: ensures the FS_MIGRATIONS list in test harnesses stays in sync
 * with actual fs-touching migrations in schema.ts.
 *
 * Scans src/db/schema.ts for runOnce blocks that reference fs.* functions
 * and verifies they're all listed in the harness's FS_MIGRATIONS array.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SCHEMA_PATH = resolve(process.cwd(), 'src/db/schema.ts');

const FS_MIGRATIONS_IN_HARNESS = [
  'export-agents-system-prompt-to-md',
  'migrate-doc-knowledge-to-files',
  'migrate-documents-v2-cleanup',
  'migrate-documents-use-agent-name',
  'backfill-documents-content-hash',
  'migrate-health-records-to-plugin',
];

function extractFsMigrationIds(): string[] {
  const src = readFileSync(SCHEMA_PATH, 'utf-8');
  const ids: string[] = [];

  const runOnceRegex = /runOnce\('([^']+)',\s*(?:\(\)\s*=>|function)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = runOnceRegex.exec(src)) !== null) {
    const migrationId = match[1];
    const startPos = match.index;

    let braceDepth = 0;
    let blockStart = -1;
    for (let i = startPos; i < src.length; i++) {
      if (src[i] === '{') {
        if (braceDepth === 0) blockStart = i;
        braceDepth++;
      } else if (src[i] === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          const block = src.slice(blockStart, i + 1);
          const fsPattern = /fs\.(rmSync|cpSync|writeFileSync|mkdirSync|renameSync|unlinkSync|rmdirSync|readFileSync|existsSync|readdirSync|statSync)/;
          if (fsPattern.test(block)) {
            ids.push(migrationId);
          }
          break;
        }
      }
    }
  }
  return ids;
}

describe('FS migration guard', () => {
  it('all fs-touching migrations in schema.ts are listed in FS_MIGRATIONS', () => {
    const actual = extractFsMigrationIds();
    const missing = actual.filter(id => !FS_MIGRATIONS_IN_HARNESS.includes(id));
    expect(
      missing,
      `These migrations touch the filesystem but are NOT in FS_MIGRATIONS:\n${missing.join('\n')}\n\nAdd them to both test-harness.ts and unit-harness.ts`,
    ).toEqual([]);
  });

  it('no stale entries in FS_MIGRATIONS that no longer exist in schema.ts', () => {
    const actual = extractFsMigrationIds();
    const stale = FS_MIGRATIONS_IN_HARNESS.filter(id => !actual.includes(id));
    expect(
      stale,
      `These entries are in FS_MIGRATIONS but no longer touch fs in schema.ts:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('detects at least the known fs migrations', () => {
    const actual = extractFsMigrationIds();
    expect(actual.length).toBeGreaterThanOrEqual(3);
    expect(actual).toContain('export-agents-system-prompt-to-md');
    expect(actual).toContain('migrate-doc-knowledge-to-files');
  });
});
