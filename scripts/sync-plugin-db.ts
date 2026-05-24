#!/usr/bin/env npx tsx
/**
 * One-time sync: backfill missing events and pricing data from yanyu.db
 * into the client-manager plugin DB.
 *
 * Usage: npx tsx scripts/sync-plugin-db.ts [--dry-run]
 */
import Database from 'better-sqlite3';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN_DB_PATH = path.join(ROOT, 'data/yanyu.db');
const PLUGIN_DB_PATH = path.join(ROOT, 'data/plugins/client-manager/client-manager.db');

const dryRun = process.argv.includes('--dry-run');

const mainDb = new Database(MAIN_DB_PATH, { readonly: true });
const pluginDb = new Database(PLUGIN_DB_PATH);
pluginDb.pragma('journal_mode = WAL');

// ── 1. Sync missing events ──────────────────────────────────────────

const pluginEventIds = new Set(
  (pluginDb.prepare('SELECT id FROM client_events').all() as { id: string }[]).map(r => r.id),
);

const mainEvents = mainDb.prepare(
  "SELECT * FROM events WHERE entity_type = 'client' ORDER BY created_at ASC",
).all() as any[];

const missingEvents = mainEvents.filter(e => !pluginEventIds.has(e.id));

const userRows = mainDb.prepare('SELECT id, username, display_name FROM users').all() as any[];
const userNameMap = new Map<string, string>();
for (const u of userRows) {
  userNameMap.set(u.id, u.display_name || u.username);
}

console.log(`[events] main=${mainEvents.length}  plugin=${pluginEventIds.size}  missing=${missingEvents.length}`);

if (missingEvents.length > 0 && !dryRun) {
  const ins = pluginDb.prepare(`
    INSERT OR IGNORE INTO client_events (id, client_id, action, payload, performed_by, performed_by_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = pluginDb.transaction(() => {
    for (const e of missingEvents) {
      ins.run(e.id, e.entity_id, e.action, e.payload, e.performed_by,
        userNameMap.get(e.performed_by) || e.performed_by, e.created_at);
    }
  });
  tx();
  console.log(`[events] inserted ${missingEvents.length} missing events`);
}

// ── 2. Sync pricing fields (only fill NULLs in plugin DB) ───────────

const PRICING_COLS = [
  'long_financing_spread', 'short_financing', 'commission',
  'commission_cost', 'net_comm', 'index_hedging', 'pricing_range',
] as const;

const mainClients = mainDb.prepare('SELECT * FROM clients').all() as any[];
const pluginClients = pluginDb.prepare('SELECT * FROM clients').all() as any[];
const pluginMap = new Map(pluginClients.map((c: any) => [c.id, c]));

let pricingUpdated = 0;

for (const mc of mainClients) {
  const pc = pluginMap.get(mc.id);
  if (!pc) continue;

  const hasMissing = PRICING_COLS.some(col => pc[col] == null && mc[col] != null);
  if (!hasMissing) continue;

  const sets: string[] = [];
  const vals: any[] = [];
  for (const col of PRICING_COLS) {
    if (pc[col] == null && mc[col] != null) {
      sets.push(`${col} = ?`);
      vals.push(mc[col]);
    }
  }
  if (sets.length === 0) continue;

  console.log(`[pricing] ${mc.name}: backfill ${sets.map(s => s.split(' ')[0]).join(', ')}`);
  if (!dryRun) {
    vals.push(mc.id);
    pluginDb.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  pricingUpdated++;
}

console.log(`[pricing] updated ${pricingUpdated} clients`);

// ── 3. Sync new clients missing from plugin DB ──────────────────────

const pluginClientIds = new Set(pluginClients.map((c: any) => c.id));
const missingClients = mainClients.filter((c: any) => !pluginClientIds.has(c.id));

if (missingClients.length > 0) {
  console.log(`[clients] ${missingClients.length} clients in main DB but not in plugin DB`);
  if (!dryRun) {
    const ins = pluginDb.prepare(`
      INSERT OR IGNORE INTO clients (id, name, contact, state, wework_group, requirements, sales, tags, notes,
        long_financing_spread, short_financing, commission, commission_cost, net_comm, index_hedging, pricing_range, is_ft,
        created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = pluginDb.transaction(() => {
      for (const c of missingClients) {
        ins.run(c.id, c.name, c.contact, c.state, c.wework_group, c.requirements, c.sales, c.tags, c.notes,
          c.long_financing_spread, c.short_financing, c.commission, c.commission_cost, c.net_comm, c.index_hedging, c.pricing_range, c.is_ft,
          c.created_by, c.created_at, c.updated_at);
      }
    });
    tx();
    console.log(`[clients] inserted ${missingClients.length} missing clients`);
  }
} else {
  console.log('[clients] all in sync');
}

// ── Done ─────────────────────────────────────────────────────────────

mainDb.close();
pluginDb.close();

console.log(dryRun ? '\n(dry-run, no changes written)' : '\ndone.');
