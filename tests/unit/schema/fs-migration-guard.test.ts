/**
 * Guard test: ensures legacy schema migrations do not touch the filesystem.
 *
 * Scans src/db/schema.ts for runOnce blocks that reference fs.* functions
 * so tests do not need to pre-mark side-effecting schema migrations.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SCHEMA_PATH = resolve(process.cwd(), 'src/db/schema.ts');

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
  it('schema.ts does not contain fs-touching legacy migrations', () => {
    const actual = extractFsMigrationIds();
    expect(
      actual,
      `Move filesystem-touching migrations out of schema.ts:\n${actual.join('\n')}`,
    ).toEqual([]);
  });
});
