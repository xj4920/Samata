#!/usr/bin/env npx tsx
/**
 * Delete all documents matching a source_path prefix, then clear import-xbase state.
 * Usage: npx tsx scripts/cleanup-import.ts /tmp/xbase/AutoDailyReport --agent alter-ego
 */
import fs from 'fs';
import path from 'path';

const STATE_FILE = path.resolve(process.cwd(), 'data/import-xbase-state.json');

interface CliSession { sessionId: string; }

async function api<T>(baseUrl: string, method: string, apiPath: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${apiPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${apiPath}`);
  return res.json() as Promise<T>;
}

async function main() {
  const args = process.argv.slice(2);
  const pathPrefix = args.find(a => !a.startsWith('--'));
  const agentFlag = args.find(a => a.startsWith('--agent='))?.split('=')[1]
    || (args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined);

  if (!pathPrefix) {
    console.error('Usage: npx tsx scripts/cleanup-import.ts <path_prefix> [--agent <name>]');
    process.exit(1);
  }

  const baseUrl = process.env.SAMATA_CLI_URL || 'http://127.0.0.1:3457';
  const username = process.env.SAMATA_USER || 'admin';
  const agentName = agentFlag || process.env.SAMATA_AGENT || 'alter-ego';

  const { session } = await api<{ ok: boolean; session: CliSession }>(
    baseUrl, 'POST', '/api/cli/session', { username, agentName },
  );

  // List docs
  const listRes = await api<{ ok: boolean; output: string[] }>(
    baseUrl, 'POST', '/api/cli/execute',
    { sessionId: session.sessionId, input: '/doc-list' },
  );
  const output = (listRes.output || []).join('\n');
  const ids: string[] = [];
  for (const line of output.split('\n')) {
    if (!line.includes(pathPrefix)) continue;
    const m = line.match(/\[([a-f0-9]{8})\]/);
    if (m) ids.push(m[1]);
  }

  console.log(`Found ${ids.length} documents matching "${pathPrefix}"`);

  let deleted = 0;
  for (const id of ids) {
    const res = await api<{ ok: boolean; output: string[] }>(
      baseUrl, 'POST', '/api/cli/execute',
      { sessionId: session.sessionId, input: `/doc-del ${id}` },
    );
    const out = (res.output || []).join('');
    if (out.includes('已删除')) { deleted++; process.stdout.write('.'); }
    else console.log(`\n  skip ${id}: ${out.slice(0, 60)}`);
  }
  console.log(`\nDeleted: ${deleted}`);

  // Clear import state for matching paths
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const before = state.completed?.length || 0;
    state.completed = (state.completed || []).filter((p: string) => !p.startsWith(pathPrefix));
    for (const key of Object.keys(state.failed || {})) {
      if (key.startsWith(pathPrefix)) delete state.failed[key];
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    console.log(`State cleared: ${before - (state.completed?.length || 0)} entries removed`);
  }

  await api(baseUrl, 'DELETE', '/api/cli/session', { sessionId: session.sessionId }).catch(() => {});
  console.log('Done. You can now re-run import-xbase.ts');
}

main().catch(err => { console.error(err); process.exit(1); });
