#!/usr/bin/env npx tsx
/**
 * Phase 3: Bulk import Xbase directory into Samata documents via CLI API.
 *
 * Usage:
 *   npx tsx scripts/import-xbase.ts <xbase_dir> --agent <agent_name>
 *
 * Env:
 *   SAMATA_CLI_URL  (default http://127.0.0.1:3457)
 *   SAMATA_USER     (default admin username from env)
 *   SAMATA_AGENT    (optional default target agent)
 *
 * Progress: data/import-xbase-state.<agent>.json (resume on re-run)
 */
import fs from 'fs';
import path from 'path';

const EXTENSIONS = new Set(['.md', '.docx', '.pdf', '.txt', '.xlsx', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.html', '.htm']);

interface State {
  completed: string[];
  failed: Record<string, string>;
}

interface CliSession {
  sessionId: string;
  agentName: string;
  agentDisplayName?: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npx tsx scripts/import-xbase.ts <xbase_dir> --agent <agent_name>',
    '',
    'Env:',
    '  SAMATA_CLI_URL  default http://127.0.0.1:3457',
    '  SAMATA_USER     default admin',
    '  SAMATA_AGENT    optional default target agent',
  ].join('\n');
}

function stateFileForAgent(agentName: string): string {
  const safeName = agentName.replace(/[^A-Za-z0-9_-]+/g, '_');
  return path.resolve(process.cwd(), `data/import-xbase-state.${safeName}.json`);
}

function loadState(stateFile: string): State {
  if (!fs.existsSync(stateFile)) return { completed: [], failed: {} };
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as State;
  } catch {
    return { completed: [], failed: {} };
  }
}

function saveState(stateFile: string, state: State): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('.')) walk(full);
      } else if (EXTENSIONS.has(path.extname(ent.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out.sort();
}

async function api<T>(baseUrl: string, method: string, apiPath: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${apiPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${method} ${apiPath}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }

  const xbaseDir = args.find(a => !a.startsWith('--'));
  const agentFlag = args.find(a => a.startsWith('--agent='))?.split('=')[1]
    || (args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined);

  if (!xbaseDir) {
    console.error(usage());
    process.exit(1);
  }

  const agentName = agentFlag || process.env.SAMATA_AGENT;
  if (!agentName) {
    console.error('Missing target agent. Provide --agent <agent_name> or SAMATA_AGENT.');
    console.error(usage());
    process.exit(1);
  }

  const resolvedRoot = path.resolve(xbaseDir);
  if (!fs.existsSync(resolvedRoot)) {
    console.error(`Directory not found: ${resolvedRoot}`);
    process.exit(1);
  }

  const baseUrl = process.env.SAMATA_CLI_URL || 'http://127.0.0.1:3457';
  const username = process.env.SAMATA_USER || 'admin';
  const stateFile = stateFileForAgent(agentName);

  const files = collectFiles(resolvedRoot);
  const state = loadState(stateFile);
  const completedSet = new Set(state.completed);

  console.log(`Xbase: ${resolvedRoot}`);
  console.log(`Files: ${files.length}, already done: ${completedSet.size}`);
  console.log(`Samata: ${baseUrl} user=${username} agent=${agentName}`);

  const health = await fetch(`${baseUrl}/health`).catch(() => null);
  if (!health?.ok) {
    console.error('Samata server not reachable. Run: npm run server');
    process.exit(1);
  }

  const { ok, session } = await api<{ ok: boolean; session: CliSession }>(
    baseUrl, 'POST', '/api/cli/session', { username, agentName },
  );
  if (!ok || !session?.sessionId) {
    console.error('Failed to create CLI session');
    process.exit(1);
  }
  if (session.agentName !== agentName) {
    await api(baseUrl, 'DELETE', '/api/cli/session', { sessionId: session.sessionId }).catch(() => {});
    console.error(`Target agent not available: requested=${agentName}, resolved=${session.agentName || '<empty>'}`);
    console.error('Refusing to import documents into a different agent.');
    process.exit(1);
  }

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    if (completedSet.has(filePath)) {
      skipped++;
      continue;
    }

    const rel = path.relative(resolvedRoot, filePath);
    console.log(`[${i + 1}/${files.length}] ${rel}`);

    try {
      const res = await api<{ ok: boolean; output: string[]; error?: string }>(
        baseUrl, 'POST', '/api/cli/execute',
        { sessionId: session.sessionId, input: `/doc-import --no-compile ${filePath}` },
      );

      if (!res.ok) {
        failed++;
        state.failed[filePath] = res.error || 'unknown';
        console.log(`  FAIL: ${state.failed[filePath]}`);
        continue;
      }

      const out = (res.output || []).join('\n');
      if (out.includes('已导入过') || out.includes('请勿重复导入') || out.includes('跳过')) {
        skipped++;
        console.log('  SKIP (duplicate)');
      } else if (out.includes('文档已导入') || out.includes('success')) {
        imported++;
        console.log('  OK');
      } else {
        imported++;
        console.log('  OK (see output)');
      }

      state.completed.push(filePath);
      delete state.failed[filePath];
      saveState(stateFile, state);
    } catch (e: any) {
      failed++;
      state.failed[filePath] = e.message;
      saveState(stateFile, state);
      console.log(`  ERROR: ${e.message}`);
    }
  }

  if (imported > 0) {
    console.log(`\nTriggering wiki compile (${imported} new documents)...`);
    try {
      const compileRes = await api<{ ok: boolean; output: string[] }>(
        baseUrl, 'POST', '/api/cli/execute',
        { sessionId: session.sessionId, input: '/compile-wiki --async' },
      );
      const out = (compileRes.output || []).join('\n');
      console.log(out || 'Wiki compile done.');
    } catch (e: any) {
      console.log(`Wiki compile failed: ${e.message}`);
      console.log('Run manually via CLI: /compile-wiki');
    }
  }

  await api(baseUrl, 'DELETE', '/api/cli/session', { sessionId: session.sessionId }).catch(() => {});

  console.log(`\nDone: imported=${imported} skipped=${skipped} failed=${failed}`);
  console.log(`State: ${stateFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
