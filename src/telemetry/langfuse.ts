import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  propagateAttributes,
  startActiveObservation,
  startObservation,
  type LangfuseAgent,
  type LangfuseGeneration,
  type LangfuseTool,
} from '@langfuse/tracing';
import type { AgentConfig } from '../llm/agents/config.js';
import type { CreateMessageParams, CreateMessageResult } from '../llm/provider.js';
import type { User } from '../auth/rbac.js';
import { log } from '../utils/logger.js';

let sdk: NodeSDK | null = null;
let started = false;
let warnedMissingConfig = false;
let warnedStartFailure = false;

function boolEnv(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

function isEnabled(): boolean {
  return boolEnv('LANGFUSE_ENABLED') || boolEnv('LANGFUSE_OBSERVE_AGENTCHAT');
}

function captureContent(): boolean {
  return boolEnv('LANGFUSE_CAPTURE_CONTENT');
}

function captureSystemPrompt(): boolean {
  return boolEnv('LANGFUSE_CAPTURE_SYSTEM_PROMPT');
}

function truncateText(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...(truncated, ${text.length} chars total)`;
}

function safeJson(value: unknown, max = 4000): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return truncateText(value, max);
  try {
    const json = JSON.stringify(value);
    if (json.length <= max) return JSON.parse(json);
    return truncateText(json, max);
  } catch {
    return String(value).slice(0, max);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringMeta(value: unknown): string {
  return String(value ?? '').slice(0, 200);
}

function ensureStarted(): boolean {
  if (!isEnabled()) return false;
  if (started) return true;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      log.warn('Langfuse 已启用，但缺少 LANGFUSE_PUBLIC_KEY 或 LANGFUSE_SECRET_KEY，跳过 agentchat 观测');
    }
    return false;
  }

  try {
    sdk = new NodeSDK({
      serviceName: process.env.LANGFUSE_SERVICE_NAME || 'samata',
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey,
          secretKey,
          baseUrl: process.env.LANGFUSE_BASE_URL,
          environment: process.env.LANGFUSE_TRACING_ENVIRONMENT,
          release: process.env.LANGFUSE_RELEASE,
          exportMode: process.env.LANGFUSE_EXPORT_MODE === 'immediate' ? 'immediate' : 'batched',
          flushAt: process.env.LANGFUSE_FLUSH_AT ? Number(process.env.LANGFUSE_FLUSH_AT) : undefined,
          flushInterval: process.env.LANGFUSE_FLUSH_INTERVAL ? Number(process.env.LANGFUSE_FLUSH_INTERVAL) : undefined,
          timeout: process.env.LANGFUSE_TIMEOUT ? Number(process.env.LANGFUSE_TIMEOUT) : undefined,
        }),
      ],
      metricReaders: [],
      logRecordProcessors: [],
      instrumentations: [],
    });
    sdk.start();
    started = true;
    return true;
  } catch (err) {
    if (!warnedStartFailure) {
      warnedStartFailure = true;
      log.warn(`Langfuse 初始化失败，跳过 agentchat 观测: ${errorMessage(err)}`);
    }
    return false;
  }
}

export async function shutdownLangfuseTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    log.warn(`Langfuse flush/shutdown 失败: ${errorMessage(err)}`);
  } finally {
    sdk = null;
    started = false;
  }
}

export interface LangfuseAgentChatContext {
  userInput: string;
  user: User;
  agent?: AgentConfig;
  channel: string;
  streamEnabled: boolean;
  imageCount: number;
  activeToolCount: number;
  model: string;
}

function buildRootInput(ctx: LangfuseAgentChatContext): unknown {
  if (captureContent()) {
    return {
      text: truncateText(ctx.userInput),
      image_count: ctx.imageCount,
    };
  }
  return {
    text_chars: ctx.userInput.length,
    image_count: ctx.imageCount,
    content_redacted: true,
  };
}

function buildRootOutput(text: string): unknown {
  if (captureContent()) return { text: truncateText(text) };
  return {
    text_chars: text.length,
    content_redacted: true,
  };
}

export async function withLangfuseAgentChat<T>(
  ctx: LangfuseAgentChatContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (!ensureStarted()) return fn();

  return startActiveObservation(
    'samata.agentchat',
    async (agentObs: LangfuseAgent) => {
      agentObs.update({
        input: buildRootInput(ctx),
        metadata: {
          channel: ctx.channel,
          user_id: ctx.user.id,
          username: ctx.user.username,
          agent_id: ctx.agent?.id ?? 'unknown',
          agent_name: ctx.agent?.name ?? 'unknown',
          agent_display_name: ctx.agent?.displayName ?? 'unknown',
          model: ctx.model,
          stream_enabled: ctx.streamEnabled,
          active_tool_count: ctx.activeToolCount,
          capture_content: captureContent(),
          capture_system_prompt: captureSystemPrompt(),
        },
      });

      return propagateAttributes({
        userId: stringMeta(ctx.user.id),
        sessionId: stringMeta(ctx.user.id),
        traceName: 'samata.agentchat',
        tags: [
          'samata',
          'agentchat',
          `channel:${ctx.channel}`,
          `agent:${ctx.agent?.name ?? 'unknown'}`,
        ],
        metadata: {
          channel: stringMeta(ctx.channel),
          agent_id: stringMeta(ctx.agent?.id ?? 'unknown'),
          agent_name: stringMeta(ctx.agent?.name ?? 'unknown'),
          model: stringMeta(ctx.model),
        },
      }, async () => {
        try {
          const result = await fn();
          if (typeof result === 'string') {
            agentObs.update({ output: buildRootOutput(result) });
          }
          return result;
        } catch (err) {
          agentObs.update({
            level: 'ERROR',
            statusMessage: errorMessage(err),
            output: { error: errorMessage(err) },
          });
          throw err;
        }
      });
    },
    { asType: 'agent' },
  ) as Promise<T>;
}

function summarizeMessages(params: CreateMessageParams): unknown {
  const messages = params.messages ?? [];
  const last = messages[messages.length - 1] as any;
  const roles = messages.map((m: any) => m.role).filter(Boolean);
  const toolNames = (params.tools ?? []).map((t: any) => t.name).filter(Boolean);

  const summary: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.max_tokens,
    message_count: messages.length,
    roles,
    system_chars: typeof params.system === 'string' ? params.system.length : 0,
    tools_count: toolNames.length,
    tool_names: toolNames,
  };

  if (last) {
    summary.last_message_role = last.role;
    summary.last_message_chars = typeof last.content === 'string'
      ? last.content.length
      : JSON.stringify(last.content ?? '').length;
  }

  return summary;
}

function buildGenerationInput(params: CreateMessageParams): unknown {
  const base = summarizeMessages(params);
  if (!captureContent()) return { ...(base as Record<string, unknown>), content_redacted: true };

  return {
    ...(base as Record<string, unknown>),
    system: captureSystemPrompt()
      ? truncateText(String(params.system ?? ''))
      : { chars: String(params.system ?? '').length, redacted: true },
    messages: safeJson(params.messages),
  };
}

function extractTextOutput(result: CreateMessageResult): unknown {
  if (!captureContent()) {
    return {
      content_blocks: result.content.length,
      stop_reason: result.stop_reason,
      content_redacted: true,
    };
  }

  const text = result.content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('\n');
  return {
    stop_reason: result.stop_reason,
    text: truncateText(text),
    content: safeJson(result.content),
  };
}

export function startLangfuseGeneration(
  round: number,
  params: CreateMessageParams,
): LangfuseGeneration | null {
  if (!ensureStarted()) return null;

  try {
    return startObservation(
      `llm.round.${round}`,
      {
        model: params.model,
        input: buildGenerationInput(params),
        modelParameters: {
          maxTokens: params.max_tokens,
        },
        metadata: {
          round,
          tools_count: params.tools?.length ?? 0,
          capture_content: captureContent(),
          capture_system_prompt: captureSystemPrompt(),
        },
      },
      { asType: 'generation' },
    );
  } catch (err) {
    log.warn(`Langfuse generation start 失败: ${errorMessage(err)}`);
    return null;
  }
}

export function finishLangfuseGeneration(
  obs: LangfuseGeneration | null,
  result: CreateMessageResult,
  durationMs: number,
): void {
  if (!obs) return;
  try {
    const inputTokens = result.usage?.input_tokens ?? 0;
    const outputTokens = result.usage?.output_tokens ?? 0;
    obs.update({
      output: extractTextOutput(result),
      usageDetails: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      metadata: {
        stop_reason: result.stop_reason,
        duration_ms: durationMs,
      },
    });
  } catch (err) {
    obs.update({
      level: 'ERROR',
      statusMessage: errorMessage(err),
      output: { error: errorMessage(err) },
    });
  } finally {
    obs.end();
  }
}

export function failLangfuseGeneration(
  obs: LangfuseGeneration | null,
  err: unknown,
): void {
  if (!obs) return;
  try {
    obs.update({
      level: 'ERROR',
      statusMessage: errorMessage(err),
      output: { error: errorMessage(err) },
    });
  } finally {
    obs.end();
  }
}

export function startLangfuseTool(
  name: string,
  round: number,
  input: unknown,
): LangfuseTool | null {
  if (!ensureStarted()) return null;

  try {
    return startObservation(
      `tool.${name}`,
      {
        input: captureContent()
          ? safeJson(input)
          : { input_chars: JSON.stringify(input ?? '').length, content_redacted: true },
        metadata: {
          tool_name: name,
          round,
          capture_content: captureContent(),
        },
      },
      { asType: 'tool' },
    );
  } catch (err) {
    log.warn(`Langfuse tool start 失败: ${errorMessage(err)}`);
    return null;
  }
}

export function finishLangfuseTool(
  obs: LangfuseTool | null,
  result: string,
  opts: {
    success: boolean;
    durationMs: number;
    error?: string;
  },
): void {
  if (!obs) return;

  try {
    obs.update({
      output: captureContent()
        ? truncateText(result)
        : {
            output_chars: result.length,
            output_bytes: Buffer.byteLength(result, 'utf-8'),
            content_redacted: true,
          },
      level: opts.success ? 'DEFAULT' : 'ERROR',
      statusMessage: opts.error,
      metadata: {
        success: opts.success,
        duration_ms: opts.durationMs,
      },
    });
  } catch (err) {
    obs.update({
      level: 'ERROR',
      statusMessage: errorMessage(err),
      output: { error: errorMessage(err) },
    });
  } finally {
    obs.end();
  }
}
