import Anthropic from '@anthropic-ai/sdk';
import { getProvider, getProviderName, getProviderByName, getModelName, type ProviderName, type CreateMessageParams, type CreateMessageResult } from './provider.js';
import { getCurrentUser, type User } from '../auth/rbac.js';
import type { AgentConfig } from './agents/config.js';
import { getAgentTools, getDefaultAgent, getCurrentAgent, setCurrentAgent, type DeliveryContext, type ToolContext } from './agents/config.js';
import { buildSystemPrompt } from './agents/prompt.js';
import { isPendingReload, setPendingReload } from './reload.js';
import { getAllNativeTools, executeNativeTool } from '../tools/index.js';
import { getMcpTools, callMcpTool } from '../services/mcp-manager.js';
import { getPluginTools, executePluginTool } from '../plugins/registry.js';
import { isAgentAdmin, isSystemAdmin } from '../auth/rbac.js';
import { log } from '../utils/logger.js';
import { throwIfAborted } from '../utils/abort.js';
import { renderMarkdown } from '../utils/markdown.js';
import * as fs from 'fs';
import * as path from 'path';
import { getExecutionChannel } from '../runtime/execution-context.js';
import { startTurn, recordLLM, recordTool, endTurn } from '../telemetry/emitter.js';

// Re-export shared types so existing import paths keep working
export type { DeliveryContext, ToolContext };
export { getCurrentAgent, setCurrentAgent };

const showThinking = () => process.env.SHOW_THINKING !== 'false';

/** 图片输入（base64 编码） */
export interface ImageInput {
  data: string;  // base64 encoded image data (no data URI prefix)
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

/** 从 Buffer magic bytes 检测图片 MIME 类型 */
export function detectImageMediaType(buf: Buffer): ImageInput['mediaType'] {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/png'; // fallback
}

/**
 * 依次尝试 primary → minimax → anthropic 进行图片描述。
 * 只要某一个成功就返回结果，全部失败才抛最后一个错误。
 * 供 runAgenticChat 及 document-import 等复用。
 */
export async function describeImageWithFallback(
  primary: import('./provider.js').LLMProvider | undefined,
  imageDataUrl: string,
  prompt: string,
  logPrefix = '',
): Promise<{ desc: string; providerName: string }> {
  const chain: import('./provider.js').LLMProvider[] = [];
  const seen = new Set<string>();
  const add = (p: import('./provider.js').LLMProvider | undefined) => {
    if (p && p.describeImage && !seen.has(p.name)) {
      chain.push(p);
      seen.add(p.name);
    }
  };
  add(primary);
  add(getProviderByName('minimax'));
  add(getProviderByName('anthropic'));

  if (chain.length === 0) {
    throw new Error('无可用的图片描述 provider（需启用 gf/minimax/anthropic 之一）');
  }

  let lastErr: unknown;
  for (const p of chain) {
    try {
      const desc = await p.describeImage!(imageDataUrl, prompt);
      return { desc, providerName: p.name };
    } catch (e: any) {
      lastErr = e;
      log.warn(`${logPrefix}图片描述失败 [${p.name}]: ${e?.message ?? e}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function executeTool(name: string, input: any, deliveryContext?: DeliveryContext, onProgress?: (event: { type: 'tool_progress'; message: string }) => void): Promise<string> {
  const globalTools = getGlobalTools();
  const ctx: ToolContext = { deliveryContext, globalTools, onProgress };
  if (name.startsWith('mcp_')) {
    return callMcpTool(name, input);
  }
  const pluginResult = await executePluginTool(name, input);
  if (pluginResult !== null) return pluginResult;
  return executeNativeTool(name, input, ctx);
}

// --- History management ---

const MAX_HISTORY_MESSAGES = 80;
const MAX_TOOL_ROUNDS = 30;
const MAX_TOOL_RESULT_LENGTH = 4000;

function isToolResultMessage(msg: Anthropic.MessageParam): boolean {
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as any[]).some(b => b.type === 'tool_result');
}

function isContextOverflowError(err: any): boolean {
  const msg = err?.message ?? '';
  return /context.window.exceeds.limit|token.*limit.*exceeded|maximum.*context.*length/i.test(msg);
}

function isOrphanToolError(err: any): boolean {
  const msg = err?.message ?? '';
  return /tool.result.*tool.id.*not found|tool_call_id.*not found|tool call result does not follow tool call|insufficient.*tool.*messages.*following.*tool_calls/i.test(msg);
}

/**
 * Safely trim history from the front, ensuring tool_use/tool_result pairs stay intact.
 * The cut point always lands on a plain 'user' message (not a tool_result follow-up).
 */
function trimHistory(history: Anthropic.MessageParam[], maxLen: number = MAX_HISTORY_MESSAGES): void {
  if (history.length <= maxLen) return;
  let cutIndex = history.length - maxLen;
  while (cutIndex < history.length) {
    const msg = history[cutIndex];
    if (msg.role === 'user' && !isToolResultMessage(msg)) break;
    cutIndex++;
  }
  if (cutIndex > 0 && cutIndex < history.length) {
    history.splice(0, cutIndex);
  }
  sanitizeToolPairs(history);
}

/**
 * Remove orphan tool_use / tool_result messages so the API never sees
 * a tool_call_id without its matching assistant tool_use (or vice-versa).
 * Mutates history in-place.
 *
 * Two-pass detection:
 *   1. Global ID match — tool_use without tool_result (or vice-versa).
 *   2. Structural ordering — tool_results must immediately follow the
 *      assistant message that issued the corresponding tool_use.
 *      If a non-tool user message appears before results, the open
 *      tool_use IDs become orphan (breaks OpenAI-compat APIs like DeepSeek
 *      that require tool messages to directly follow tool_calls).
 */
function sanitizeToolPairs(history: Anthropic.MessageParam[]): void {
  // Pass 1: global ID matching
  const toolUseIds = new Set<string>();
  for (const msg of history) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block.type === 'tool_use' && block.id) toolUseIds.add(block.id);
      }
    }
  }

  const toolResultIds = new Set<string>();
  for (const msg of history) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block.type === 'tool_result' && block.tool_use_id) toolResultIds.add(block.tool_use_id);
      }
    }
  }

  const orphanUseIds = new Set([...toolUseIds].filter(id => !toolResultIds.has(id)));
  const orphanResultIds = new Set([...toolResultIds].filter(id => !toolUseIds.has(id)));

  // Pass 2: structural ordering validation.
  // Tool_results must appear in user messages that directly follow the
  // assistant message with the corresponding tool_use — without any
  // non-tool user message in between.
  let openUseIds = new Set<string>();
  for (const msg of history) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // New assistant turn: any unfulfilled IDs from previous turn are orphan
      for (const id of openUseIds) orphanUseIds.add(id);
      openUseIds = new Set<string>();
      for (const block of msg.content as any[]) {
        if (block.type === 'tool_use' && block.id) {
          if (orphanUseIds.has(block.id)) continue; // already known orphan
          openUseIds.add(block.id);
        }
      }
    } else if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        const hasToolResult = (msg.content as any[]).some((b: any) => b.type === 'tool_result');
        if (hasToolResult) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              if (openUseIds.has(block.tool_use_id)) {
                openUseIds.delete(block.tool_use_id);
              } else {
                // tool_result references an ID not currently open → orphan
                orphanResultIds.add(block.tool_use_id);
              }
            }
          }
        } else {
          // Non-tool user message closes open IDs → mark as orphan
          for (const id of openUseIds) orphanUseIds.add(id);
          openUseIds = new Set<string>();
        }
      } else {
        // Plain string user message → close open IDs
        for (const id of openUseIds) orphanUseIds.add(id);
        openUseIds = new Set<string>();
      }
    }
  }
  // Any IDs still open at the end of history
  for (const id of openUseIds) orphanUseIds.add(id);

  if (orphanUseIds.size === 0 && orphanResultIds.size === 0) return;

  const badIds = new Set([...orphanUseIds, ...orphanResultIds]);

  // Strip orphan blocks; remove emptied messages
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!Array.isArray(msg.content)) continue;
    const blocks = msg.content as any[];
    const cleaned = blocks.filter(b => {
      if (b.type === 'tool_use' && badIds.has(b.id)) return false;
      if (b.type === 'tool_result' && badIds.has(b.tool_use_id)) return false;
      return true;
    });
    if (cleaned.length === 0) {
      history.splice(i, 1);
    } else if (cleaned.length !== blocks.length) {
      msg.content = cleaned;
    }
  }
}

/**
 * Deep cleanup: strip ALL tool_use and tool_result blocks from history,
 * keeping only text/thinking content. Used as a last resort when
 * sanitizeToolPairs is insufficient (e.g. structural corruption that
 * ID-based matching can't fix).
 */
function stripAllToolBlocks(history: Anthropic.MessageParam[]): void {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!Array.isArray(msg.content)) continue;
    const blocks = msg.content as any[];
    const cleaned = blocks.filter(b => b.type !== 'tool_use' && b.type !== 'tool_result');
    if (cleaned.length === 0) {
      history.splice(i, 1);
    } else if (cleaned.length !== blocks.length) {
      msg.content = cleaned;
    }
  }
}

// --- Conversation state ---
let conversationHistory: Anthropic.MessageParam[] = [];

/** All globally registered tools (native + plugins + MCP servers) */
export function getGlobalTools(): Anthropic.Tool[] {
  return [...getAllNativeTools(), ...getPluginTools(), ...getMcpTools()];
}

/** @deprecated Use getGlobalTools() + getAgentTools() instead */
export function getTools(): Anthropic.Tool[] {
  return getGlobalTools();
}

/** @deprecated Use buildSystemPrompt() from prompt.ts instead. Hardcoded prompt removed per CLAUDE.md rule. */

/**
 * Strip <think> blocks from model output.
 * When showThinking is true, extracted thoughts are printed via log.dim().
 */
function stripThinkBlocks(text: string, showThinkingOpt: boolean): string {
  if (showThinkingOpt) {
    for (const m of text.matchAll(/<think>([\s\S]*?)<\/think>/g)) {
      const thought = m[1].trim();
      if (thought) log.dim(`💭 ${thought}`);
    }
  }
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** 判断是否为可重试的瞬态网络错误 */
function isTransientError(err: any): boolean {
  const msg = (err?.message ?? '').toLowerCase();
  const cause = (err?.cause?.message ?? '').toLowerCase();
  const combined = msg + ' ' + cause;
  return /fetch failed|econnreset|econnrefused|etimedout|und_err_connect_timeout|network|socket hang up/.test(combined)
    || /\b(502|503|504|520|529)\b/.test(msg);
}

const CALLLLM_MAX_RETRIES = 2;

/**
 * 调用 LLM，优先使用流式输出（CLI 逐字显示），回退到非流式。
 * 对瞬态网络错误自动重试（最多 CALLLLM_MAX_RETRIES 次），通过 onProgress 通知调用方。
 * 返回 { result, streamed } — streamed 表示文本已经输出到 stdout
 */
async function callLLM(
  params: CreateMessageParams,
  streamText: boolean,
  showThinkingOpt: boolean = false,
  providerOverride?: import('./provider.js').LLMProvider,
  onTextChunk?: (chunk: string) => void,
  onProgress?: (event: ProgressEvent) => void,
): Promise<{ result: CreateMessageResult; streamed: boolean }> {
  const provider = providerOverride ?? getProvider();

  for (let attempt = 0; ; attempt++) {
    try {
      if (streamText && provider.createMessageStream) {
        try {
          let result: CreateMessageResult | null = null;
          let buffer = '';
          for await (const event of provider.createMessageStream(params)) {
            throwIfAborted();
            if (event.type === 'text_delta') {
              buffer += event.text;
            } else if (event.type === 'done') {
              result = { content: event.content, stop_reason: event.stop_reason, usage: event.usage };
            }
          }
          if (buffer) {
            const clean = stripThinkBlocks(buffer, showThinkingOpt);
            if (clean) {
              log.print();
              const rendered = renderMarkdown(clean);
              const line = rendered.trimEnd() + '\n';
              if (onTextChunk) {
                onTextChunk(line);
              } else {
                process.stdout.write(line);
              }
            }
          }
          if (!result) throw new Error('Stream ended without done event');
          return { result, streamed: !!buffer };
        } catch (err: any) {
          if (isTransientError(err)) throw err;
          log.dim(`流式请求失败 (${err.message})，回退到非流式...`);
        }
      }

      throwIfAborted();
      return { result: await provider.createMessage(params), streamed: false };
    } catch (err: any) {
      if (attempt < CALLLLM_MAX_RETRIES && isTransientError(err)) {
        throwIfAborted();
        const delay = 1000 * (attempt + 1);
        log.warn(`LLM 网络抖动 (${err.message})，${delay / 1000}s 后重试 (${attempt + 1}/${CALLLLM_MAX_RETRIES})...`);
        onProgress?.({ type: 'tool_progress', message: `⚠️ 网络抖动，${delay / 1000}s 后重试 (${attempt + 1}/${CALLLLM_MAX_RETRIES})...` });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

export type ProgressEvent =
  | { type: 'tool_start'; name: string; input: unknown; round: number }
  | { type: 'tool_end'; name: string; result: string; round: number; durationMs: number }
  | { type: 'thinking'; text: string; round: number }
  | { type: 'tool_progress'; message: string };

/**
 * 通用的 agentic chat 函数，支持 CLI 和飞书bot复用
 * @param history 消息历史数组（会被修改）
 * @param userInput 用户输入
 * @param user 当前用户（用于生成 system prompt）
 * @param options 配置选项
 * @returns 最终的文本回复
 */
export async function runAgenticChat(
  history: Anthropic.MessageParam[],
  userInput: string,
  user: User,
  options: {
    streamEnabled?: boolean;
    logPrefix?: string;
    showThinking?: boolean;
    agentConfig?: AgentConfig;
    images?: ImageInput[];
    onProgress?: (event: ProgressEvent) => void;
    onTextChunk?: (chunk: string) => void;
    deliveryContext?: DeliveryContext;
  } = {}
): Promise<string> {
  const { streamEnabled = false, logPrefix = '', showThinking: showThinkingOpt = showThinking(), agentConfig, images, onProgress, onTextChunk, deliveryContext } = options;

  const agent = agentConfig;
  const agentProviderOverride = agent?.provider
    ? getProviderByName(agent.provider as ProviderName) ?? undefined
    : undefined;
  const maxHistory = agent?.maxHistory ?? MAX_HISTORY_MESSAGES;
  const allTools = getGlobalTools();
  const userIsAdmin = agent ? isAgentAdmin(agent.id) : true;
  const activeTools = agent ? getAgentTools(agent, allTools, userIsAdmin) : allTools;
  const systemPrompt = buildSystemPrompt(agent ?? getDefaultAgent(), user);

  // Telemetry: start turn
  const ctxStartTime = Date.now();
  const telemetrySessionId = user.id;
  const telemetryAgentId = agent?.id ?? getDefaultAgent()?.id ?? 'unknown';
  startTurn(telemetrySessionId, telemetryAgentId);

  // Helper: wrap callLLM with telemetry recording
  async function trackedCallLLM(
    round: number,
    stream: boolean,
    showTh: boolean,
    provOverride?: import('./provider.js').LLMProvider,
    onChunk?: (chunk: string) => void,
    onProg?: (event: ProgressEvent) => void,
  ): Promise<{ result: CreateMessageResult; streamed: boolean }> {
    const llmStart = Date.now();
    const r = await callLLM(makeParams(), stream, showTh, provOverride, onChunk, onProg);
    recordLLM(telemetrySessionId, {
      round,
      model: provOverride?.defaultModel ?? getModelName(),
      input_tokens: r.result.usage?.input_tokens ?? 0,
      output_tokens: r.result.usage?.output_tokens ?? 0,
      stop_reason: r.result.stop_reason,
      duration_ms: Date.now() - llmStart,
    });
    return r;
  }

  // 设置当前 agent 上下文，供 tool handler（如 search_knowledge）按 agent 过滤数据
  const prevAgent = getCurrentAgent();
  if (agent) setCurrentAgent(agent);

  // 图片预处理：优先用当前 provider.describeImage，fallback 到 anthropic（Claude 原生多模态）
  let processedImages: ImageInput[] | undefined = images;
  let processedInput = userInput;

  if (images && images.length > 0) {
    const activeProvider = agentProviderOverride ?? getProvider();
    const hasAnyDescriber = !!(activeProvider.describeImage
      || getProviderByName('minimax')?.describeImage
      || getProviderByName('anthropic')?.describeImage);

    if (hasAnyDescriber) {
      const descriptions: string[] = [];
      const usedProviders: string[] = [];
      for (const img of images) {
        const dataUrl = `data:${img.mediaType};base64,${img.data}`;
        const { desc, providerName } = await describeImageWithFallback(
          activeProvider,
          dataUrl,
          userInput || '请描述这张图片的内容',
          logPrefix,
        );
        descriptions.push(desc);
        usedProviders.push(providerName);
      }
      const descText = descriptions.map((d, i) => `[图片${i + 1}]\n${d}`).join('\n\n');
      processedInput = `${descText}\n\n${userInput}`.trim();
      processedImages = undefined;
      const uniq = [...new Set(usedProviders)].join('+');
      log.dim(`${logPrefix}📷 图片已转为文字描述 (via ${uniq})`);
    }
    // 若无任何 describer，保留原图进 chat（仅当前 provider 原生支持多模态时有效）
  }

  trimHistory(history, maxHistory);

  const historyLenBefore = history.length;

  // 构建 user message：如果有图片则使用 content block 数组
  if (processedImages && processedImages.length > 0) {
    const contentBlocks: Anthropic.MessageParam['content'] = [];
    for (const img of processedImages) {
      (contentBlocks as any[]).push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      });
    }
    if (processedInput) {
      (contentBlocks as any[]).push({ type: 'text', text: processedInput });
    }
    history.push({ role: 'user', content: contentBlocks });
  } else {
    history.push({ role: 'user', content: processedInput });
  }

  const makeParams = (): CreateMessageParams => ({
    model: agent?.model ?? (agentProviderOverride?.defaultModel ?? getModelName()),
    max_tokens: 16384,
    system: systemPrompt,
    tools: activeTools,
    messages: history,
  });

  // Record context prep time
  const ctx_ms = Date.now() - ctxStartTime;

  let response: CreateMessageResult;
  let streamed: boolean;
  try {
    ({ result: response, streamed } = await trackedCallLLM(1, streamEnabled, showThinkingOpt, agentProviderOverride, onTextChunk, onProgress));
  } catch (err: any) {
    endTurn(telemetrySessionId, { loop_rounds: 1, stop_reason: 'error', answer_preview: '', ctx_ms, render_ms: 0 });
    if (isOrphanToolError(err) && historyLenBefore > 0) {
      log.warn(`${logPrefix}检测到 orphan tool 消息，清理历史后重试...`);
      history.length = historyLenBefore;
      sanitizeToolPairs(history);
      history.push({ role: 'user', content: processedInput });
      try {
        ({ result: response, streamed } = await trackedCallLLM(1, streamEnabled, showThinkingOpt, agentProviderOverride, onTextChunk, onProgress));
      } catch (retryErr: any) {
        if (isOrphanToolError(retryErr)) {
          log.warn(`${logPrefix}标准清理不足，执行深度清理后重试...`);
          history.length = historyLenBefore;
          stripAllToolBlocks(history);
          history.push({ role: 'user', content: processedInput });
          try {
            ({ result: response, streamed } = await trackedCallLLM(1, streamEnabled, showThinkingOpt, agentProviderOverride, onTextChunk, onProgress));
          } catch (deepRetryErr: any) {
            log.error(`${logPrefix}深度清理后仍失败: ${deepRetryErr?.message ?? String(deepRetryErr)}`);
            throw deepRetryErr;
          }
        } else {
          log.error(`${logPrefix}重试仍失败: ${retryErr?.message ?? String(retryErr)}`);
          throw retryErr;
        }
      }
    } else {
      log.error(`${logPrefix}AI 请求失败: ${err?.message ?? String(err)}`);
      history.length = historyLenBefore;
      throw err;
    }
  }

  // Agentic loop: keep processing until no more tool calls
  let round = 1;
  while (response.stop_reason === 'tool_use') {
    throwIfAborted();

    if (round > MAX_TOOL_ROUNDS) {
      log.warn(`${logPrefix}达到最大工具调用轮次 (${MAX_TOOL_ROUNDS})，停止`);
      // Strip unanswered tool_use blocks so session.history does not carry
      // orphan tool_calls into the next turn (breaks OpenAI-compat gateways).
      response = {
        ...response,
        content: response.content.filter(b => b.type !== 'tool_use'),
        stop_reason: 'end_turn',
      };
      break;
    }

    const assistantContent = response.content;
    history.push({ role: 'assistant', content: assistantContent });

    if (!streamed && showThinkingOpt) {
      for (const block of assistantContent) {
        if (block.type === 'text' && block.text) {
          log.dim(`${logPrefix}💭 ${block.text}`);
          onProgress?.({ type: 'thinking', text: block.text, round });
        }
      }
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    const activeToolNames = new Set(activeTools.map(t => t.name));
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        if (showThinkingOpt) {
          log.dim(`${logPrefix}🔧 调用工具: ${block.name}`);
          log.dim(`${logPrefix}   参数: ${JSON.stringify(block.input)}`);
        }
        onProgress?.({ type: 'tool_start', name: block.name, input: block.input, round });
        throwIfAborted();
        const toolStartedAt = Date.now();
        let result: string;
        let toolError: string | undefined;
        if (!activeToolNames.has(block.name)) {
          const errMsg = `权限不足：工具 "${block.name}" 不在当前用户的允许列表中`;
          result = JSON.stringify({ error: errMsg });
          toolError = errMsg;
        } else {
          try {
            result = await executeTool(block.name, block.input, deliveryContext, onProgress);
          } catch (err: any) {
            const errMsg = `工具执行异常: ${err.message}`;
            result = JSON.stringify({ error: errMsg });
            toolError = errMsg;
          }
        }
        if (result.length > MAX_TOOL_RESULT_LENGTH) {
          result = result.slice(0, MAX_TOOL_RESULT_LENGTH) + `\n...(truncated, ${result.length} chars total)`;
        }
        const toolDuration = Date.now() - toolStartedAt;
        recordTool(telemetrySessionId, {
          name: block.name,
          round,
          duration_ms: toolDuration,
          success: !toolError,
          bytes: Buffer.byteLength(result, 'utf-8'),
          error: toolError,
        });
        onProgress?.({ type: 'tool_end', name: block.name, result, round, durationMs: toolDuration });
        if (showThinkingOpt) {
          const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
          log.dim(`${logPrefix}   结果: ${preview}`);
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    history.push({ role: 'user', content: toolResults });

    try {
      ({ result: response, streamed } = await trackedCallLLM(round, streamEnabled, showThinkingOpt, agentProviderOverride, onTextChunk, onProgress));
    } catch (err: any) {
      if (isContextOverflowError(err) && history.length > historyLenBefore + 4) {
        log.warn(`${logPrefix}上下文溢出，截断历史后重试...`);
        // Keep the original user message + last 2 tool rounds (4 messages: assistant+toolResult x2)
        const keepFromTurn = Math.max(historyLenBefore + 1, history.length - 4);
        history.splice(historyLenBefore + 1, keepFromTurn - historyLenBefore - 1);
        sanitizeToolPairs(history);
        try {
          ({ result: response, streamed } = await trackedCallLLM(round, streamEnabled, showThinkingOpt, agentProviderOverride, onTextChunk, onProgress));
          round += 1;
          continue;
        } catch (retryErr: any) {
          log.error(`${logPrefix}重试仍失败: ${retryErr?.message ?? String(retryErr)}`);
          history.length = historyLenBefore;
          endTurn(telemetrySessionId, { loop_rounds: round, stop_reason: 'error', answer_preview: '', ctx_ms, render_ms: 0 });
          throw retryErr;
        }
      }
      if (isOrphanToolError(err)) {
        log.warn(`${logPrefix}检测到 orphan tool 消息，清理历史后重试...`);
        sanitizeToolPairs(history);
        try {
          ({ result: response, streamed } = await trackedCallLLM(round, streamEnabled, showThinkingOpt, agentProviderOverride, onTextChunk, onProgress));
          round += 1;
          continue;
        } catch (retryErr: any) {
          if (isOrphanToolError(retryErr)) {
            log.warn(`${logPrefix}标准清理不足，执行深度清理后重试...`);
            stripAllToolBlocks(history);
            try {
              ({ result: response, streamed } = await trackedCallLLM(round, streamEnabled, showThinkingOpt, agentProviderOverride, onTextChunk, onProgress));
              round += 1;
              continue;
            } catch (deepRetryErr: any) {
              log.error(`${logPrefix}深度清理后仍失败: ${deepRetryErr?.message ?? String(deepRetryErr)}`);
              endTurn(telemetrySessionId, { loop_rounds: round, stop_reason: 'error', answer_preview: '', ctx_ms, render_ms: 0 });
              throw deepRetryErr;
            }
          } else {
            log.error(`${logPrefix}重试仍失败: ${retryErr?.message ?? String(retryErr)}`);
            endTurn(telemetrySessionId, { loop_rounds: round, stop_reason: 'error', answer_preview: '', ctx_ms, render_ms: 0 });
            throw retryErr;
          }
        }
      }
      log.error(`${logPrefix}AI 请求失败: ${err?.message ?? String(err)}`);
      history.length = historyLenBefore;
      endTurn(telemetrySessionId, { loop_rounds: round, stop_reason: 'error', answer_preview: '', ctx_ms, render_ms: 0 });
      throw err;
    }
    round += 1;
  }

  const assistantContent = response.content;
  history.push({ role: 'assistant', content: assistantContent });

  // 提取文本回复
  let textReply = '';
  for (const block of assistantContent) {
    if (block.type === 'text') {
      textReply += block.text;
    }
  }

  const renderStart = Date.now();
  // 非流式回退时，文本未在 callLLM 中输出，这里兜底渲染
  if (!streamed && textReply) {
    const clean = stripThinkBlocks(textReply, showThinkingOpt);
    if (clean) {
      log.print();
      const rendered = renderMarkdown(clean);
      const line = rendered.trimEnd() + '\n';
      if (onTextChunk) {
        onTextChunk(line);
      } else {
        process.stdout.write(line);
      }
    }
  }
  const render_ms = Date.now() - renderStart;

  // Telemetry: end turn
  endTurn(telemetrySessionId, {
    loop_rounds: round,
    stop_reason: response.stop_reason,
    answer_preview: textReply,
    ctx_ms,
    render_ms,
  });

  // 延迟执行 reload：等 agentic loop 结束、回复渲染完毕后再重启
  if (isPendingReload()) {
    setPendingReload(false);
    log.info('🔄 即将重载应用...');
    setTimeout(async () => {
      const { gracefulShutdown } = await import('../index.js');
      gracefulShutdown();
      process.exit(120);
    }, 500);
  }

  return textReply;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const IMAGE_PATH_RE = /(?:^|\s)((?:\/|\.\/|~\/)\S+\.(?:png|jpe?g|gif|webp))\b/gi;

/**
 * 从用户输入中提取本地图片路径，返回 images 数组。
 * 保留原始路径在文本中（供 archive_health_file 等工具使用）。
 */
function extractLocalImages(input: string): { text: string; images: ImageInput[] } {
  const images: ImageInput[] = [];
  // Collect images but keep paths in text so the model can reference them
  let match: RegExpExecArray | null;
  IMAGE_PATH_RE.lastIndex = 0;
  while ((match = IMAGE_PATH_RE.exec(input)) !== null) {
    const filePath = match[1];
    const resolved = filePath.startsWith('~/')
      ? path.join(process.env.HOME || '', filePath.slice(1))
      : path.resolve(filePath);
    try {
      if (!fs.existsSync(resolved)) continue;
      const buf = fs.readFileSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mediaType: ImageInput['mediaType'] =
        ext === '.png' ? 'image/png'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : 'image/jpeg';
      images.push({ data: buf.toString('base64'), mediaType });
    } catch (e) {
      // skip unreadable files
    }
  }

  return { text: input || (images.length > 0 ? '请描述这张图片' : ''), images };
}

export async function chat(userInput: string): Promise<void> {
  try {
    const { text, images } = extractLocalImages(userInput);
    if (images.length > 0) {
      log.dim(`📎 已加载 ${images.length} 张图片`);
    }
    await runAgenticChat(conversationHistory, text, getCurrentUser(), {
      streamEnabled: true,
      showThinking: showThinking(),
      agentConfig: getCurrentAgent(),
      images: images.length > 0 ? images : undefined,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    const msg = err?.message ?? String(err);
    log.print(`AI 请求失败: ${msg}`);
  }
}

export function resetConversation(): void {
  conversationHistory = [];
  setCurrentAgent(undefined);
}
