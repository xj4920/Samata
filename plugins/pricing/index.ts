import type { PluginModule, PluginContext } from '@samata-platform/plugin-sdk';
import { toolDefinitions } from './src/tools.js';
import { getPricingDb, closePricingDb, getDb } from './src/db.js';
import { importPricingQuote, queryPricingQuote, listPricingQuoteDates } from './src/commands.js';
import type Database from 'better-sqlite3';

let db: Database.Database | null = null;

const plugin: PluginModule = {
  name: 'pricing',
  description: '产品利率报价管理：导入、查询FXD/FRN利率矩阵',
  scope: 'agent-bound',
  toolDefinitions,

  async init(ctx: PluginContext) {
    db = getPricingDb(ctx.getDataDir());
    await migrateFromMainDb(ctx);
  },

  async stop() {
    closePricingDb();
    db = null;
  },

  async handleTool(name: string, input: any, ctx: PluginContext) {
    if (!db) return null;

    const user = ctx.getCurrentUser();
    const agentId = ctx.getAgentId() || '';
    const isAdmin = ctx.isAdmin?.() ?? false;

    switch (name) {
      case 'import_pricing_quote': {
        if (!isAdmin) return JSON.stringify({ error: '权限不足：需要 Agent 管理员权限' });
        return JSON.stringify(importPricingQuote(db, input.file_path, agentId, user.id, input.quote_type, input.dry_run ?? true));
      }
      case 'query_pricing_quote':
        return JSON.stringify(queryPricingQuote(db, agentId, {
          quote_type: input.quote_type,
          date: input.date,
          currency: input.currency,
          tenor: input.tenor,
          rate_type: input.rate_type,
        }));
      case 'list_pricing_quote_dates':
        return JSON.stringify(listPricingQuoteDates(db, agentId, input.quote_type));
      default:
        return null;
    }
  },
};

/**
 * @deprecated One-time migration from main DB — violates plugin isolation (direct DB access).
 * Kept for backward compat; remove after 2026-Q3 when all instances have migrated.
 */
async function migrateFromMainDb(ctx: PluginContext): Promise<void> {
  if (!db) return;

  const count = db.prepare('SELECT COUNT(*) as c FROM pricing_quotes').get() as { c: number };
  if (count.c > 0) return;

  const dataDir = ctx.getDataDir();
  const projectRoot = dataDir.replace(/\/data\/plugins\/pricing$/, '');
  const mainDbPath = `${projectRoot}/data/samata.db`;

  let mainDb: any;
  try {
    const Database = (await import('better-sqlite3')).default;
    mainDb = new Database(mainDbPath, { readonly: true });
  } catch {
    return;
  }

  try {
    const rows = mainDb.prepare('SELECT * FROM pricing_quotes').all();
    if (rows.length === 0) return;

    const ins = db.prepare(`
      INSERT OR IGNORE INTO pricing_quotes (id, agent_id, quote_type, quote_date, file_name, data, metadata, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const r of rows as any[]) {
        ins.run(r.id, r.agent_id, r.quote_type, r.quote_date, r.file_name, r.data, r.metadata, r.created_by, r.created_at);
      }
    });
    tx();

    console.log(`[pricing] 数据迁移完成: ${rows.length} 条报价记录`);
  } finally {
    mainDb.close();
  }
}

export default plugin;
