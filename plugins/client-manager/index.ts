import type { PluginModule, PluginContext } from '@samata/plugin-sdk';
import { toolDefinitions } from './src/tools.js';
import { getClientDb, closeClientDb, getDb } from './src/db.js';
import { STATE_LABELS, STATE_PRIORITY, classifyClient } from './src/model.js';
import {
  fetchClients, fetchClient, fetchHistory,
  createClient, updateClient, advanceClient, rollbackClient, deleteClient,
  parsePricingRange, importPricingSchedule,
} from './src/commands.js';
import type Database from 'better-sqlite3';

let db: Database.Database | null = null;

const plugin: PluginModule = {
  name: 'client-manager',
  description: '客户管理：查询、添加、更新客户状态，导入报价',
  scope: 'agent-bound',
  toolDefinitions,

  async init(ctx: PluginContext) {
    db = getClientDb(ctx.getDataDir());
    await migrateFromMainDb(ctx);
  },

  async stop() {
    closeClientDb();
    db = null;
  },

  async handleTool(name: string, input: any, ctx: PluginContext) {
    if (!db) return null;

    const user = ctx.getCurrentUser();
    const userId = user.id;
    const userName = user.name;
    const isAdmin = ctx.isAdmin?.() ?? false;

    const WRITE_TOOLS = new Set(['add_client', 'update_client', 'advance_client', 'rollback_client', 'delete_client', 'import_pricing_schedule']);
    if (WRITE_TOOLS.has(name) && !isAdmin) {
      return JSON.stringify({ error: '权限不足：需要 Agent 管理员权限' });
    }

    switch (name) {
      case 'query_clients': {
        const rows = fetchClients(db, input);
        rows.sort((a, b) => {
          return (STATE_PRIORITY[b.state] ?? 0) - (STATE_PRIORITY[a.state] ?? 0);
        });
        return JSON.stringify(rows.map(c => {
          const category = classifyClient(c.is_ft === 1, c.short_financing);
          return {
            id: c.id.slice(0, 8),
            name: c.name,
            wework_group: c.wework_group,
            requirements: c.requirements,
            sales: c.sales,
            contact: c.contact,
            state: STATE_LABELS[c.state],
            tags: c.tags,
            category,
            notes: c.notes,
            long_financing_spread: c.long_financing_spread,
            short_financing: c.short_financing,
            commission: c.commission,
            commission_cost: c.commission_cost,
            net_comm: c.net_comm,
            index_hedging: c.index_hedging === 1 ? true : c.index_hedging === 0 ? false : null,
            pricing_range: parsePricingRange(c.pricing_range),
            is_ft: c.is_ft === 1,
            created_at: c.created_at,
            updated_at: c.updated_at,
          };
        }));
      }

      case 'view_client': {
        const client = fetchClient(db, input.name_or_id);
        if (!client) return JSON.stringify({ error: `未找到客户: ${input.name_or_id}` });
        const category = classifyClient(client.is_ft === 1, client.short_financing);
        return JSON.stringify({
          id: client.id,
          name: client.name,
          wework_group: client.wework_group,
          requirements: client.requirements,
          sales: client.sales,
          contact: client.contact,
          state: STATE_LABELS[client.state],
          tags: client.tags,
          category,
          notes: client.notes,
          long_financing_spread: client.long_financing_spread,
          short_financing: client.short_financing,
          commission: client.commission,
          commission_cost: client.commission_cost,
          net_comm: client.net_comm,
          index_hedging: client.index_hedging === 1 ? true : client.index_hedging === 0 ? false : null,
          pricing_range: parsePricingRange(client.pricing_range),
          is_ft: client.is_ft === 1,
          created_at: client.created_at,
          updated_at: client.updated_at,
        });
      }

      case 'get_client_history': {
        const result = fetchHistory(db, input.name_or_id);
        if (!result) return JSON.stringify({ error: `未找到客户: ${input.name_or_id}` });
        return JSON.stringify(result.events.map(e => ({
          action: e.action,
          payload: e.payload,
          performed_by: e.performed_by_name,
          time: e.created_at,
        })));
      }

      case 'add_client':
        return JSON.stringify(createClient(db, input, userId, userName));

      case 'update_client':
        return JSON.stringify(updateClient(db, input.name_or_id, input.fields, userId, userName));

      case 'advance_client':
        return JSON.stringify(advanceClient(db, input.name_or_id, userId, userName));

      case 'rollback_client':
        return JSON.stringify(rollbackClient(db, input.name_or_id, userId, userName));

      case 'delete_client':
        return JSON.stringify(deleteClient(db, input.name_or_id, input.dry_run ?? true, userId, userName));

      case 'import_pricing_schedule':
        return JSON.stringify(await importPricingSchedule(db, {
          filePath: input.file_path,
          dryRun: input.dry_run ?? true,
        }, userId, userName));

      default:
        return null;
    }
  },
};

/**
 * One-time data migration from main DB clients table to plugin DB.
 * Only runs if plugin DB is empty and main DB has data.
 */
async function migrateFromMainDb(ctx: PluginContext): Promise<void> {
  if (!db) return;

  const count = db.prepare('SELECT COUNT(*) as c FROM clients').get() as { c: number };
  if (count.c > 0) return;

  // Try to access main DB through a migration helper
  // The main DB path is relative to project root
  const dataDir = ctx.getDataDir();
  const projectRoot = dataDir.replace(/\/data\/plugins\/client-manager$/, '');
  const mainDbPath = `${projectRoot}/data/samata.db`;

  let mainDb: any;
  try {
    const Database = (await import('better-sqlite3')).default;
    mainDb = new Database(mainDbPath, { readonly: true });
  } catch {
    return;
  }

  try {
    const clients = mainDb.prepare('SELECT * FROM clients').all();
    if (clients.length === 0) return;

    const ins = db.prepare(`
      INSERT OR IGNORE INTO clients (id, name, contact, state, wework_group, requirements, sales, tags, notes,
        long_financing_spread, short_financing, commission, commission_cost, net_comm, index_hedging, pricing_range, is_ft,
        created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const c of clients as any[]) {
        ins.run(c.id, c.name, c.contact, c.state, c.wework_group, c.requirements, c.sales, c.tags, c.notes,
          c.long_financing_spread, c.short_financing, c.commission, c.commission_cost, c.net_comm, c.index_hedging, c.pricing_range, c.is_ft,
          c.created_by, c.created_at, c.updated_at);
      }
    });
    tx();

    // Migrate client events from main DB events table
    const events = mainDb.prepare("SELECT * FROM events WHERE entity_type = 'client' ORDER BY created_at ASC").all();
    if (events.length > 0) {
      const insEvent = db.prepare(`
        INSERT OR IGNORE INTO client_events (id, client_id, action, payload, performed_by, performed_by_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      // Get user names from main DB
      const users = mainDb.prepare('SELECT id, username, display_name FROM users').all() as Array<{ id: string; username: string; display_name: string | null }>;
      const userNameMap = new Map<string, string>();
      for (const u of users) {
        userNameMap.set(u.id, u.display_name || u.username);
      }

      const txEvents = db.transaction(() => {
        for (const e of events as any[]) {
          insEvent.run(e.id, e.entity_id, e.action, e.payload, e.performed_by, userNameMap.get(e.performed_by) || e.performed_by, e.created_at);
        }
      });
      txEvents();
    }

    console.log(`[client-manager] 数据迁移完成: ${clients.length} 客户, ${events.length} 事件`);
  } finally {
    mainDb.close();
  }
}

export default plugin;
