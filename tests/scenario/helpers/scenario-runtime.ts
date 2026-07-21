import Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { vi } from 'vitest';
import { ToolFixtureRouter } from '../../../src/evaluation/fixture-router.js';
import type { ScenarioCase, ScenarioExecutionResult } from '../../../src/evaluation/types.js';

const state = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  router: undefined as ToolFixtureRouter | undefined,
  extraTools: [] as Anthropic.Tool[],
  mcpTools: [] as Anthropic.Tool[],
  providerOverride: undefined as import('../../../src/llm/provider.js').LLMProvider | undefined,
  metrics: {
    inputTokens: 0,
    outputTokens: 0,
    loopRounds: 0,
  },
}));

vi.mock('../../../src/db/connection.js', () => ({
  getDb: () => {
    if (!state.db) throw new Error('scenario runtime DB 尚未初始化');
    return state.db;
  },
  closeDb: () => {
    state.db?.close();
    state.db = undefined;
  },
}));

vi.mock('../../../src/utils/logger.js', () => ({
  log: {
    info: () => {}, success: () => {}, warn: () => {}, error: () => {},
    dim: () => {}, file: () => {}, print: () => {},
  },
}));

vi.mock('../../../src/telemetry/emitter.js', () => ({
  startTurn: () => 'scenario-turn',
  recordLLM: (_session: string, call: { round: number; input_tokens: number; output_tokens: number }) => {
    state.metrics.inputTokens += call.input_tokens;
    state.metrics.outputTokens += call.output_tokens;
    state.metrics.loopRounds = Math.max(state.metrics.loopRounds, call.round);
  },
  recordTool: () => {},
  recordKnowledge: () => {},
  endTurn: (_session: string, options: { loop_rounds: number }) => {
    state.metrics.loopRounds = Math.max(state.metrics.loopRounds, options.loop_rounds);
  },
}));

vi.mock('../../../src/telemetry/langfuse.js', () => ({
  withLangfuseAgentChat: async (_context: unknown, fn: () => Promise<unknown>) => fn(),
  startLangfuseGeneration: () => null,
  finishLangfuseGeneration: () => {},
  failLangfuseGeneration: () => {},
  startLangfuseTool: () => null,
  finishLangfuseTool: () => {},
  shutdownLangfuseTelemetry: async () => {},
}));

vi.mock('../../../src/plugins/registry.js', () => ({
  getPluginTools: () => state.extraTools,
  getUniversalPluginTools: () => [],
  executePluginTool: async (name: string, input: unknown) => {
    if (!state.router || name.startsWith('mcp_')) return null;
    if (!state.router.unusedResponses().some(item => item.tool === name)
      && !state.router.calls.some(item => item.tool === name)) return null;
    return state.router.execute(name, input);
  },
  getPluginSkills: () => [],
  getPluginSkillByName: () => null,
  getLoadedPlugins: () => [],
  initPlugins: async () => {},
  startAllPlugins: async () => {},
  stopAllPlugins: async () => {},
  stopPluginWatcher: () => {},
}));

vi.mock('../../../src/services/mcp-manager.js', () => ({
  getMcpTools: () => state.mcpTools,
  isMcpToolAllowedForAgent: () => true,
  callMcpTool: async (name: string, input: unknown) => {
    if (!state.router) throw new Error('scenario fixture router 尚未初始化');
    return state.router.execute(name, input);
  },
  initMcpServers: async () => {},
}));

function genericTool(name: string): Anthropic.Tool {
  return {
    name,
    description: `[场景回归 fixture] ${name}`,
    input_schema: { type: 'object', additionalProperties: true },
  } as Anthropic.Tool;
}

async function resetRuntime(scenarioCase: ScenarioCase): Promise<void> {
  vi.useRealTimers();
  try { state.db?.close(); } catch {}
  state.db = new Database(':memory:');
  state.db.pragma('foreign_keys = ON');
  state.router = new ToolFixtureRouter(scenarioCase.fixtures);
  state.metrics = { inputTokens: 0, outputTokens: 0, loopRounds: 0 };

  const { initDatabase } = await import('../../../src/db/schema.js');
  await initDatabase();
  const { seedTestAgents } = await import('../../helpers/seed-data.js');
  seedTestAgents(state.db);

  const { getAllNativeTools } = await import('../../../src/tools/index.js');
  const nativeNames = new Set(getAllNativeTools().map(tool => tool.name));
  state.mcpTools = scenarioCase.fixtures
    .filter(fixture => fixture.tool.startsWith('mcp_'))
    .map(fixture => genericTool(fixture.tool));
  state.extraTools = scenarioCase.fixtures
    .filter(fixture => !fixture.tool.startsWith('mcp_') && !nativeNames.has(fixture.tool))
    .map(fixture => genericTool(fixture.tool));
}

export async function executeScenarioWithCurrentAgent(
  scenarioCase: ScenarioCase,
  repetition: number,
): Promise<ScenarioExecutionResult> {
  await resetRuntime(scenarioCase);
  const startedAt = Date.now();
  if (scenarioCase.input.fixedTime) vi.setSystemTime(new Date(scenarioCase.input.fixedTime));

  const { initProviders, registerProvider, switchProvider } = await import('../../../src/llm/provider.js');
  const initialized = await initProviders();
  if (!initialized) throw new Error('没有可用 LLM provider；请检查评测环境配置');
  if (state.providerOverride) registerProvider('custom', state.providerOverride);
  const requestedProvider = process.env.EVAL_PROVIDER;
  if (requestedProvider && !switchProvider(requestedProvider as any)) {
    throw new Error(`评测 provider 不可用: ${requestedProvider}`);
  }

  const { runAgenticChat, getGlobalTools } = await import('../../../src/llm/agent.js');
  const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');
  const { setCurrentUser } = await import('../../../src/auth/rbac.js');
  const allToolNames = new Set(getGlobalTools().map(tool => tool.name));
  const requestedTools = scenarioCase.assertions.allowedTools
    ?? scenarioCase.fixtures.map(fixture => fixture.tool);
  const unavailable = requestedTools.filter(tool => !allToolNames.has(tool));
  if (unavailable.length > 0) throw new Error(`场景工具未注册: ${unavailable.join(', ')}`);

  const user = {
    id: `scenario-user-${scenarioCase.id}`,
    username: 'scenario-evaluator',
    role: scenarioCase.input.role === 'admin' ? 'admin' as const : 'user' as const,
  };
  state.db!.prepare('INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)')
    .run(user.id, user.username, user.role);
  setCurrentUser(user);
  const agentConfig = {
    id: `scenario-agent-${scenarioCase.id}`,
    name: scenarioCase.input.agent,
    displayName: `Scenario ${scenarioCase.input.agent}`,
    toolsMode: 'allowlist' as const,
    toolsList: requestedTools,
    blockTools: [],
    userToolsMode: 'inherit' as const,
    userToolsList: [],
    maxHistory: 80,
  };
  const history: Anthropic.MessageParam[] = (scenarioCase.input.history ?? []).map(item => ({
    role: item.role,
    content: item.content,
  }));
  const answer = await runWithExecutionContext(
    { channel: scenarioCase.input.channel as any, user, agent: agentConfig },
    () => runAgenticChat(history, scenarioCase.input.text, user, {
      streamEnabled: false,
      showThinking: false,
      agentConfig,
    }),
  );

  return {
    caseId: scenarioCase.id,
    repetition,
    answer,
    toolCalls: state.router!.calls,
    loopRounds: state.metrics.loopRounds,
    inputTokens: state.metrics.inputTokens,
    outputTokens: state.metrics.outputTokens,
    durationMs: Date.now() - startedAt,
  };
}

export function closeScenarioRuntime(): void {
  try { state.db?.close(); } catch {}
  state.db = undefined;
  state.router = undefined;
  state.providerOverride = undefined;
  vi.useRealTimers();
}

export function setScenarioProvider(provider: import('../../../src/llm/provider.js').LLMProvider): void {
  state.providerOverride = provider;
}
