/**
 * Lightweight unit-test harness: in-memory SQLite, no LLM, no network.
 * Use for testing commands, tools, RBAC, and schema without hitting external services.
 */
import { vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ─── Module mocks ───

let memoryDb: Database.Database;
const mockMcpState = vi.hoisted(() => ({
  allTools: [] as any[],
  byAgent: new Map<string, any[]>(),
}));

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => memoryDb,
  closeDb: () => { memoryDb?.close(); },
}));

vi.mock('../../src/utils/logger.js', () => ({
  log: {
    info: () => {},
    success: () => {},
    warn: () => {},
    error: () => {},
    dim: () => {},
    file: () => {},
    print: () => {},
  },
}));

vi.mock('../../src/plugins/registry.js', () => {
  // Stub tool definitions for plugins already migrated from native tools
  const pluginTools = [
    'record_wrong_question', 'list_wrong_questions',
    'mark_wrong_question_mastered', 'wrong_question_report',
    'query_clients', 'view_client', 'get_client_history',
    'add_client', 'update_client', 'advance_client', 'rollback_client',
    'delete_client', 'import_pricing_schedule',
    'import_pricing_quote', 'query_pricing_quote', 'list_pricing_quote_dates',
    'query_trades', 'trade_summary', 'plot_trades', 'list_customers',
    'export_trades_csv', 'export_north_info_csv',
    'sync_fast_trading_summary',
    'calc_etf_trades', 'query_etf_summary',
    'query_hedge_short', 'query_qfii_latest_valuation_report',
    'sync_sbl_data', 'analyze_sbl_usage',
    'sync_normal_trading_summary', 'query_normal_trading_summary', 'calc_normal_trading_annual_turnover',
    'titans_code_sync', 'titans_code_grep', 'titans_code_read', 'titans_code_list',
  ].map(name => ({ name, description: `[plugin] ${name}`, input_schema: { type: 'object', properties: {} } }));

  return {
    getPluginTools: () => pluginTools,
    getUniversalPluginTools: () => [],
    executePluginTool: async (name: string, input: any) => {
      if (name === 'calc_etf_trades' || name === 'sync_fast_trading_summary' || name === 'sync_normal_trading_summary') {
        const { getContextAgent, getExecutionChannel, isScheduledTaskAuthorized } = await import('../../src/runtime/execution-context.js');
        const { isAgentAdmin } = await import('../../src/auth/rbac.js');
        const agentId = getContextAgent()?.id;
        const authorized = isScheduledTaskAuthorized() || (agentId ? isAgentAdmin(agentId) : false);
        if (name === 'sync_fast_trading_summary' && !authorized) {
          return JSON.stringify({ error: '仅管理员可同步极速summary数据' });
        }
        if (name === 'sync_normal_trading_summary' && !authorized) {
          return JSON.stringify({ error: '仅管理员可同步常速成交与业务规模数据' });
        }
        const result: Record<string, unknown> = {
          ok: true,
          agentId,
          channel: getExecutionChannel(),
          isAdmin: authorized,
          input,
        };
        if (name === 'sync_fast_trading_summary' || name === 'sync_normal_trading_summary') result.tool = name;
        return JSON.stringify(result);
      }
      return null;
    },
    getPluginSkills: () => [],
    getPluginSkillByName: () => null,
    getLoadedPlugins: () => [],
    initPlugins: async () => {},
    startAllPlugins: async () => {},
    stopAllPlugins: async () => {},
    stopPluginWatcher: () => {},
  };
});

vi.mock('../../src/services/mcp-manager.js', () => ({
  getMcpTools: (agentName?: string) => {
    if (!agentName) return mockMcpState.allTools;
    return mockMcpState.byAgent.get(agentName) ?? [];
  },
  isMcpToolAllowedForAgent: (toolName: string, agentName?: string) => {
    if (!agentName) return true;
    return (mockMcpState.byAgent.get(agentName) ?? []).some((tool: any) => tool.name === toolName);
  },
  callMcpTool: async () => JSON.stringify({ error: 'MCP not available in test' }),
  initMcpServers: async () => {},
}));

vi.mock('../../src/telemetry/emitter.js', () => ({
  startTurn: () => 'test-turn',
  recordLLM: () => {},
  recordTool: () => {},
  recordKnowledge: () => {},
  endTurn: () => {},
}));

function ensureMigrationsTable(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

// ─── Public API ───

export interface UnitTestContext {
  db: Database.Database;
}

export interface SetupUnitDbOptions {
  seedTestAgents?: boolean;
}

export function setMockMcpTools(allTools: any[], byAgent: Record<string, any[]> = {}) {
  mockMcpState.allTools = allTools;
  mockMcpState.byAgent = new Map(Object.entries(byAgent));
}

/**
 * Initialize a fresh in-memory DB with full schema and optional test agents.
 * Also inserts a default test user and sets it as current user.
 */
export async function setupUnitDb(options: SetupUnitDbOptions = {}): Promise<UnitTestContext> {
  setMockMcpTools([]);
  memoryDb = new Database(':memory:');
  memoryDb.pragma('journal_mode = WAL');
  memoryDb.pragma('foreign_keys = ON');

  ensureMigrationsTable(memoryDb);

  const { initDatabase } = await import('../../src/db/schema.js');
  await initDatabase();

  if (options.seedTestAgents !== false) {
    const { seedTestAgents } = await import('./seed-data.js');
    seedTestAgents(memoryDb);
  }

  memoryDb.prepare(
    `INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`,
  ).run('test-user', 'testadmin', 'admin');

  const { setCurrentUser } = await import('../../src/auth/rbac.js');
  setCurrentUser({ id: 'test-user', username: 'testadmin', role: 'admin' } as any);

  return { db: memoryDb };
}

/**
 * Insert additional test seed data (clients, todos).
 */
export async function seedAll(db: Database.Database) {
  const { seedTestData } = await import('./seed-data.js');
  seedTestData(db);
}

export function teardownDb() {
  try { memoryDb?.close(); } catch {}
}

/**
 * Convenience hook for describe blocks.
 * Returns a fresh DB per test with full schema + optional seed data.
 */
export function useUnitDb(options: { seed?: boolean } = {}) {
  const ref: { ctx: UnitTestContext | null } = { ctx: null };

  beforeEach(async () => {
    ref.ctx = await setupUnitDb();
    if (options.seed) await seedAll(ref.ctx.db);
  });

  afterEach(() => {
    teardownDb();
    ref.ctx = null;
  });

  return {
    get db() { return ref.ctx!.db; },
  };
}

/**
 * Set execution context for RBAC / tool tests.
 */
export async function withContext(
  opts: { channel?: string; role?: string; agentName?: string },
  fn: () => any,
) {
  const { runWithExecutionContext } = await import('../../src/runtime/execution-context.js');
  const { setCurrentUser } = await import('../../src/auth/rbac.js');

  const user = { id: 'test-user', username: 'testadmin', role: opts.role ?? 'admin' };
  setCurrentUser(user as any);

  let agent: any = undefined;
  if (opts.agentName) {
    const { getAgent } = await import('../../src/llm/agents/config.js');
    agent = getAgent(opts.agentName);
  }

  return runWithExecutionContext(
    { channel: (opts.channel ?? 'cli') as any, user: user as any, agent },
    fn,
  );
}
