import { vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env') });

// ─── Module mocks (only DB and side-effect modules) ───

let memoryDb: Database.Database;

vi.mock('../../src/db/connection.js', () => ({
  getDb: () => memoryDb,
  closeDb: () => { memoryDb?.close(); },
}));

vi.mock('../../src/plugins/registry.js', () => ({
  getPluginTools: () => [],
  getUniversalPluginTools: () => [],
  executePluginTool: async () => null,
  getPluginSkills: () => [],
  getPluginSkillByName: () => null,
  getLoadedPlugins: () => [],
  initPlugins: async () => {},
  startAllPlugins: async () => {},
  stopAllPlugins: async () => {},
  stopPluginWatcher: () => {},
}));

vi.mock('../../src/services/mcp-manager.js', () => ({
  getMcpTools: () => [],
  isMcpToolAllowedForAgent: () => true,
  callMcpTool: async () => JSON.stringify({ error: 'MCP not available in test' }),
  initMcpServers: async () => {},
}));

vi.mock('../../src/telemetry/emitter.js', () => ({
  startTurn: () => 'test-turn',
  recordLLM: () => {},
  recordTool: () => {},
  endTurn: () => {},
}));

// ─── Types ───

export interface ToolExecution {
  name: string;
  input: any;
  result: string;
  error?: string;
}

export interface TestResult {
  reply: string;
  tools: ToolExecution[];
}

export interface TestContext {
  db: Database.Database;
  runChat: (userInput: string) => Promise<TestResult>;
  cleanup: () => void;
}

/**
 * Migrations that touch the real file system (fs.rmSync, fs.cpSync, etc.).
 * Pre-mark them as done so initSchema() won't execute them on the test DB.
 */
const FS_MIGRATIONS = [
  'export-agents-system-prompt-to-md',
  'migrate-doc-knowledge-to-files',
  'migrate-documents-v2-cleanup',
  'migrate-documents-use-agent-name',
  'backfill-documents-content-hash',
];

function extractToolExecutions(history: Anthropic.MessageParam[]): ToolExecution[] {
  const useMap = new Map<string, { name: string; input: any }>();
  const executions: ToolExecution[] = [];

  for (const msg of history) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as any[]) {
      if (block.type === 'tool_use') {
        useMap.set(block.id, { name: block.name, input: block.input });
      }
      if (block.type === 'tool_result' && useMap.has(block.tool_use_id)) {
        const use = useMap.get(block.tool_use_id)!;
        const resultStr = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        const parsed = safeParse(resultStr);
        executions.push({
          name: use.name,
          input: use.input,
          result: resultStr,
          error: parsed?.error,
        });
      }
    }
  }
  return executions;
}

export async function setupTestAgent(agentName: string): Promise<TestContext> {
  memoryDb = new Database(':memory:');
  memoryDb.pragma('journal_mode = WAL');
  memoryDb.pragma('foreign_keys = ON');

  // Pre-create migrations table and mark FS-touching migrations as done,
  // so initSchema() won't execute fs.rmSync / fs.cpSync / etc. on real files.
  memoryDb.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const insertMig = memoryDb.prepare('INSERT OR IGNORE INTO migrations (id) VALUES (?)');
  for (const id of FS_MIGRATIONS) {
    insertMig.run(id);
  }

  const { initDatabase } = await import('../../src/db/schema.js');
  await initDatabase();

  const { seedTestData } = await import('./seed-data.js');
  seedTestData(memoryDb);

  const { initProviders } = await import('../../src/llm/provider.js');
  const ok = await initProviders();
  if (!ok) throw new Error('No LLM provider available — check .env');

  const { getAgent } = await import('../../src/llm/agents/config.js');
  const agentConfig = getAgent(agentName);

  const testUser = { id: 'admin-001', username: 'admin', role: 'admin' as const };

  const { runWithExecutionContext } = await import('../../src/runtime/execution-context.js');
  const { runAgenticChat } = await import('../../src/llm/agent.js');
  const { setCurrentUser } = await import('../../src/auth/rbac.js');
  setCurrentUser(testUser);

  const runChat = async (userInput: string): Promise<TestResult> => {
    const history: Anthropic.MessageParam[] = [];

    const reply = await runWithExecutionContext(
      { channel: 'cli', user: testUser, agent: agentConfig },
      () =>
        runAgenticChat(history, userInput, testUser, {
          streamEnabled: false,
          showThinking: false,
          agentConfig,
        }),
    );

    const tools = extractToolExecutions(history);
    return { reply, tools };
  };

  const cleanup = () => {
    try { memoryDb?.close(); } catch {}
  };

  return { db: memoryDb, runChat, cleanup };
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

export function useTestAgent() {
  const ref: { ctx: TestContext | null } = { ctx: null };

  afterEach(() => {
    ref.ctx?.cleanup();
    ref.ctx = null;
  });

  return {
    ref,
    init: async (agentName: string) => {
      ref.ctx = await setupTestAgent(agentName);
      return ref.ctx;
    },
  };
}
