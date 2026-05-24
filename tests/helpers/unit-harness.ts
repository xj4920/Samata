/**
 * Lightweight unit-test harness: in-memory SQLite, no LLM, no network.
 * Use for testing commands, tools, RBAC, and schema without hitting external services.
 */
import { vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ─── Module mocks ───

let memoryDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => memoryDb,
  closeDb: () => { memoryDb?.close(); },
}));

vi.mock('../../src/plugins/registry.js', () => ({
  getPluginTools: () => [],
  executePluginTool: async () => null,
  getPluginSkills: () => [],
  initPlugins: async () => {},
}));

vi.mock('../../src/services/mcp-manager.js', () => ({
  getMcpTools: () => [],
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

// ─── FS migration auto-detection ───

/**
 * Scan schema.ts runOnce IDs that touch the real filesystem.
 * Instead of a manual list, we mark ALL known FS-touching migrations.
 * New ones should be added here when created.
 */
const FS_MIGRATIONS = [
  'export-agents-system-prompt-to-md',
  'migrate-doc-knowledge-to-files',
  'migrate-documents-v2-cleanup',
  'migrate-documents-use-agent-name',
  'backfill-documents-content-hash',
];

function prefillFsMigrations(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const ins = db.prepare('INSERT OR IGNORE INTO migrations (id) VALUES (?)');
  for (const id of FS_MIGRATIONS) ins.run(id);
}

// ─── Public API ───

export interface UnitTestContext {
  db: Database.Database;
}

/**
 * Initialize a fresh in-memory DB with full schema and seed agents.
 * Also inserts a default test user and sets it as current user.
 */
export async function setupUnitDb(): Promise<UnitTestContext> {
  memoryDb = new Database(':memory:');
  memoryDb.pragma('journal_mode = WAL');
  memoryDb.pragma('foreign_keys = ON');

  prefillFsMigrations(memoryDb);

  const { initSchema } = await import('../../src/db/schema.js');
  initSchema();

  memoryDb.prepare(
    `INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`,
  ).run('test-user', 'testadmin', 'admin');

  const { setCurrentUser } = await import('../../src/auth/rbac.js');
  setCurrentUser({ id: 'test-user', username: 'testadmin', role: 'admin' } as any);

  return { db: memoryDb };
}

/**
 * Insert additional test seed data (clients, health records, todos).
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
