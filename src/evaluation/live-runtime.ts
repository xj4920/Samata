import { getUserByIdOrUsername, isAgentAdmin, type User } from '../auth/rbac.js';
import { closeDb } from '../db/connection.js';
import { initDatabase } from '../db/schema.js';
import {
  executeTool,
  getGlobalTools,
  runAgenticChat,
  type ProgressEvent,
} from '../llm/agent.js';
import {
  getAgentTools,
  getAllAgents,
  type AgentConfig,
  type DeliveryContext,
} from '../llm/agents/config.js';
import { initProviders } from '../llm/provider.js';
import { initPlugins, startAllPlugins, stopAllPlugins, stopPluginWatcher } from '../plugins/registry.js';
import { runWithExecutionContext, type AppChannel } from '../runtime/execution-context.js';
import { initMcpServers, stopMcpServers } from '../services/mcp-manager.js';
import { shutdownLangfuseTelemetry } from '../telemetry/langfuse.js';
import type { CapturedToolCall } from './types.js';
import type {
  CanaryCase,
  CanaryExecutionResult,
  LiveToolExecution,
} from './live-types.js';

interface LiveRuntime {
  user: User;
  agent: AgentConfig;
  tools: Set<string>;
  deliveryContext?: DeliveryContext;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量: ${name}`);
  return value;
}

function exactAgent(ref: string): AgentConfig {
  const agent = getAllAgents().find(item => item.id === ref || item.name === ref);
  if (!agent) throw new Error(`未找到专用 Agent: ${ref}`);
  return agent;
}

function deliveryContextFromEnv(
  env: NodeJS.ProcessEnv,
  prefix: 'EVAL' | 'CANARY',
): DeliveryContext | undefined {
  const rawChannel = env[`${prefix}_CHANNEL`]?.trim();
  if (!rawChannel) return undefined;
  if (!['feishu', 'telegram', 'cli', 'wework'].includes(rawChannel)) {
    throw new Error(`不支持的 ${prefix}_CHANNEL: ${rawChannel}`);
  }
  return {
    channel: rawChannel as DeliveryContext['channel'],
    targetId: env[`${prefix}_TARGET_ID`]?.trim(),
    appId: env[`${prefix}_APP_ID`]?.trim(),
  };
}

function parseToolOutput(rawOutput: string): { parsedOutput: unknown; success: boolean; error?: string } {
  let parsedOutput: unknown = rawOutput;
  try {
    parsedOutput = JSON.parse(rawOutput);
  } catch {
    // Plain-text tool outputs are valid.
  }
  if (typeof parsedOutput !== 'object' || parsedOutput === null) {
    return { parsedOutput, success: true };
  }
  const record = parsedOutput as Record<string, unknown>;
  const error = typeof record.error === 'string' ? record.error : undefined;
  return {
    parsedOutput,
    success: record.success !== false && error === undefined,
    error,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超过 ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function assertToolAccess(runtime: LiveRuntime, requested: string[]): void {
  const registered = new Set(getGlobalTools().map(tool => tool.name));
  const unavailable = requested.filter(tool => !registered.has(tool));
  if (unavailable.length > 0) {
    throw new Error(`工具未注册: ${unavailable.join(', ')}`);
  }
  const denied = requested.filter(tool => !runtime.tools.has(tool));
  if (denied.length > 0) {
    throw new Error(`专用 Agent 无工具权限: ${denied.join(', ')}`);
  }
}

async function initializeRuntime(input: {
  env: NodeJS.ProcessEnv;
  kind: 'contract' | 'canary';
  withProvider: boolean;
}): Promise<LiveRuntime> {
  try {
    await initDatabase();
    await initPlugins();
    await startAllPlugins();
    await initMcpServers();
    if (input.withProvider && !(await initProviders())) {
      throw new Error('没有可用 LLM provider，无法运行 production Canary');
    }

    const prefix = input.kind === 'contract' ? 'EVAL' : 'CANARY';
    const userRef = requiredEnv(input.env, `${prefix}_USER_ID`);
    const agentRef = requiredEnv(input.env, `${prefix}_AGENT_ID`);
    const user = getUserByIdOrUsername(userRef);
    if (!user) throw new Error(`未找到专用用户: ${userRef}`);
    const agent = exactAgent(agentRef);
    const deliveryContext = deliveryContextFromEnv(input.env, prefix);
    const channel = (deliveryContext?.channel ?? 'system') as AppChannel;
    const tools = await runWithExecutionContext({ channel, user, agent }, async () => (
      new Set(getAgentTools(agent, getGlobalTools(), isAgentAdmin(agent.id)).map(tool => tool.name))
    ));
    return { user, agent, tools, deliveryContext };
  } catch (error) {
    await shutdownLiveRuntime();
    throw error;
  }
}

export async function initializeContractRuntime(
  env: NodeJS.ProcessEnv,
  requestedTools: string[],
): Promise<{
  execute: (tool: string, input: Record<string, unknown>, timeoutMs: number) => Promise<LiveToolExecution>;
  close: () => Promise<void>;
}> {
  const runtime = await initializeRuntime({ env, kind: 'contract', withProvider: false });
  assertToolAccess(runtime, requestedTools);
  return {
    execute: async (tool, input, timeoutMs) => {
      if (!runtime.tools.has(tool)) throw new Error(`专用 Agent 无工具权限: ${tool}`);
      const startedAt = Date.now();
      const channel = (runtime.deliveryContext?.channel ?? 'system') as AppChannel;
      const rawOutput = await withTimeout(
        runWithExecutionContext(
          { channel, user: runtime.user, agent: runtime.agent, appId: runtime.deliveryContext?.appId },
          () => executeTool(tool, input, runtime.deliveryContext),
        ),
        timeoutMs,
        `工具 ${tool}`,
      );
      const parsed = parseToolOutput(rawOutput);
      return { rawOutput, durationMs: Date.now() - startedAt, ...parsed };
    },
    close: shutdownLiveRuntime,
  };
}

export async function initializeCanaryRuntime(
  env: NodeJS.ProcessEnv,
  cases: CanaryCase[],
): Promise<{
  execute: (
    item: CanaryCase,
    repetition: number,
    prompt: string,
    abortSignal?: AbortSignal,
  ) => Promise<CanaryExecutionResult>;
  close: () => Promise<void>;
}> {
  const runtime = await initializeRuntime({ env, kind: 'canary', withProvider: true });
  assertToolAccess(runtime, [...new Set(cases.flatMap(item => item.allowedTools))]);
  return {
    execute: async (item, _repetition, prompt, abortSignal?: AbortSignal) => {
      assertToolAccess(runtime, item.allowedTools);
      const startedAt = Date.now();
      const calls: CapturedToolCall[] = [];
      const pending: Array<CapturedToolCall & { startedAt: number }> = [];
      let loopRounds = 0;
      const onProgress = (event: ProgressEvent): void => {
        if ('round' in event) loopRounds = Math.max(loopRounds, event.round);
        if (event.type === 'tool_start') {
          pending.push({
            tool: event.name,
            input: event.input,
            output: '',
            success: false,
            round: event.round,
            startedAt: Date.now(),
          });
        } else if (event.type === 'tool_end') {
          let index = -1;
          for (let cursor = pending.length - 1; cursor >= 0; cursor--) {
            if (pending[cursor].tool === event.name && pending[cursor].round === event.round) {
              index = cursor;
              break;
            }
          }
          const started = index >= 0 ? pending.splice(index, 1)[0] : undefined;
          const parsed = parseToolOutput(event.result);
          calls.push({
            tool: event.name,
            input: started?.input ?? {},
            output: event.result,
            success: parsed.success,
            error: parsed.error,
            round: event.round,
            durationMs: event.durationMs || (started ? Date.now() - started.startedAt : undefined),
          });
        }
      };
      const channel = (runtime.deliveryContext?.channel ?? 'system') as AppChannel;
      const answer = await runWithExecutionContext(
        { channel, user: runtime.user, agent: runtime.agent, appId: runtime.deliveryContext?.appId },
        () => runAgenticChat([], prompt, runtime.user, {
          agentConfig: runtime.agent,
          deliveryContext: runtime.deliveryContext,
          onProgress,
          showThinking: false,
          streamEnabled: false,
          toolAllowlist: item.allowedTools,
          abortSignal,
        }),
      );
      return { answer, toolCalls: calls, loopRounds, durationMs: Date.now() - startedAt };
    },
    close: shutdownLiveRuntime,
  };
}

export async function shutdownLiveRuntime(): Promise<void> {
  await Promise.allSettled([
    stopAllPlugins(),
    stopMcpServers(),
    shutdownLangfuseTelemetry(),
  ]);
  stopPluginWatcher();
  closeDb();
}
