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
  add(getProviderByName('gf'));
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
const MAX_TOOL_ROUNDS = (() => {
  const v = Number(process.env.MAX_TOOL_ROUNDS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 30;
})();

const MAX_DEVTOOLS_ROUNDS = 12;
const MAX_TOOL_RESULT_LENGTH = 4000;

function isToolResultMessage(msg: Anthropic.MessageParam): boolean {
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as any[]).some(b => b.type === 'tool_result');
}

interface ToolTrace {
  round: number;
  name: string;
  success: boolean;
  durationMs: number;
  preview: string;
  error?: string;
}

type InterruptedSummaryInput = {
  kind: 'max_rounds' | 'loop' | 'devtools_budget';
  limit: number;
  trace: ToolTrace[];
  reason?: string;
};

function truncateText(text: string, maxLen: number): string {
  const clean = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + '...' : clean;
}

function compactToolResult(result: string, error?: string): string {
  if (error) return truncateText(error, 240);

  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of ['summary', 'message', 'title', 'path', 'file_path', 'count', 'total']) {
        const value = obj[key];
        if (value === undefined || value === null) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          parts.push(`${key}: ${value}`);
        }
      }
      for (const key of ['results', 'items', 'documents', 'files', 'rows']) {
        const value = obj[key];
        if (Array.isArray(value)) parts.push(`${key}: ${value.length} 条`);
      }
      if (parts.length > 0) return truncateText(parts.join('；'), 360);
    }
  } catch {
    // Non-JSON tool results are still useful as plain text previews.
  }

  return truncateText(result, 360);
}

function countToolCalls(trace: ToolTrace[]): string {
  if (trace.length === 0) return '本轮尚未记录到工具结果。';

  const counts = new Map<string, number>();
  for (const entry of trace) {
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, count]) => count > 1 ? `${name} x${count}` : name);
  return `本轮已调用过的工具：${parts.join('、')}。`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function summarizeErrors(trace: ToolTrace[]): string[] {
  const errors = trace.filter(entry => !entry.success);
  if (errors.length === 0) return [];

  const byTool = new Map<string, { count: number; latest: string }>();
  for (const entry of errors) {
    const current = byTool.get(entry.name);
    byTool.set(entry.name, {
      count: (current?.count ?? 0) + 1,
      latest: entry.error || entry.preview || '未知错误',
    });
  }

  return [...byTool.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([name, info]) => `- ${name} 失败 ${info.count} 次，最近原因：${truncateText(info.latest, 160)}`);
}

function summarizeSuccessfulSignals(trace: ToolTrace[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const entry of trace.filter(t => t.success && t.preview).slice(-8).reverse()) {
    const key = `${entry.name}:${entry.preview}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${entry.name}: ${truncateText(entry.preview, 180)}`);
    if (lines.length >= 5) break;
  }

  return lines.reverse();
}

function buildInterruptedSummary(input: InterruptedSummaryInput): string {
  const header = input.kind === 'max_rounds'
    ? `我连续调用了 ${input.limit} 轮工具仍未整理出最终答复，先给阶段性总结，避免没有结论地结束。`
    : input.kind === 'devtools_budget'
    ? `浏览器工具调用次数已达上限（${input.limit} 次），先给阶段性总结。`
    : `我检测到工具调用陷入循环，先给阶段性总结，避免继续空转。`;
  const successful = input.trace.filter(entry => entry.success);
  const failed = input.trace.filter(entry => !entry.success);
  const totalDurationMs = input.trace.reduce((sum, entry) => sum + entry.durationMs, 0);
  const completedLines = [
    `- 已执行 ${input.trace.length} 次工具调用，其中 ${successful.length} 次成功、${failed.length} 次失败。`,
    `- ${countToolCalls(input.trace)}`,
    totalDurationMs > 0 ? `- 工具执行累计耗时约 ${formatDuration(totalDurationMs)}。` : '',
  ].filter(Boolean);
  const signalLines = summarizeSuccessfulSignals(input.trace);
  const errorLines = summarizeErrors(input.trace);
  const stuckLines = [
    input.reason ? `- ${input.reason}。` : '',
    ...(errorLines.length > 0
      ? errorLines
      : [failed.length > 0 ? `- 有 ${failed.length} 次工具调用失败，说明外部依赖、权限、文件解析或参数可能存在阻塞。` : '']),
    input.kind === 'max_rounds' ? '- 工具预算已耗尽，继续自动尝试容易重复消耗轮次。' : '- 系统已阻止继续重复调用相同工具或模式。',
  ].filter(Boolean);

  return [
    header,
    ['已完成：', ...completedLines].join('\n'),
    [
      '阶段性结论：',
      ...(signalLines.length > 0
        ? signalLines
        : ['- 暂未从工具结果中提取到足够明确的可复用线索。']),
    ].join('\n'),
    [
      '卡住原因：',
      ...stuckLines,
    ].join('\n'),
    [
      '未完成：',
      '- 尚未形成完整最终答复。',
      '- 尚未确认当前任务的所有关键信息都已覆盖。',
    ].join('\n'),
    [
      '下一步建议：',
      '- 可以基于上面的阶段性线索继续追问一个更小的问题。',
      '- 也可以直接提供关键上下文，让我跳过重复解析步骤继续整理。',
    ].join('\n'),
  ].join('\n\n');
}

function buildToolStatsFootnote(trace: ToolTrace[]): string {
  const total = trace.length;
  const success = trace.filter(t => t.success).length;
  const failed = total - success;
  return `\n\n────────────────────────────────────────\n\n> 本轮共调用 ${total} 次工具，${success} 次成功、${failed} 次失败。`;
}

// --- Loop detection ---

const LOOP_WINDOW = 12;        // 滑窗：最近 N 个工具调用
const MAX_CONSECUTIVE_SAME = 3; // 同一工具+参数连续出现 N 次 → 循环
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_PATTERN_LEN = 4;     // 多工具模式最大长度
const MIN_PATTERN_REPEATS = 2; // 模式至少重复 N 次 → 循环
const HIGH_FREQ_THRESHOLD = 0.75; // 滑窗内同一工具占比阈值（忽略参数差异）

interface LoopTracker {
  calls: { name: string; fingerprint: string; round: number }[];
  lastErrorName: string;
  lastErrorCount: number;
  softWarned: boolean;
  stateVersion: number;
}

function initLoopTracker(): LoopTracker {
  return { calls: [], lastErrorName: '', lastErrorCount: 0, softWarned: false, stateVersion: 0 };
}

const STATE_MUTATING_TOOLS = new Set(['sandbox_write_file', 'write_file', 'edit_file']);
const STATE_DEPENDENT_TOOLS = new Set(['sandbox_exec', 'exec_cmd']);

function fingerprint(input: unknown): string {
  if (typeof input !== 'object' || input === null) return JSON.stringify(input);
  return JSON.stringify(input, Object.keys(input as Record<string, unknown>).sort());
}

type LoopResult = { action: 'none' } | { action: 'soft_warn'; name: string; fingerprint: string } | { action: 'hard_stop'; name: string; fingerprint: string; isError: boolean };

function detectLoop(tracker: LoopTracker): LoopResult {
  const recent = tracker.calls.slice(-LOOP_WINDOW);

  // 1. 连续相同工具检测：同一个工具+相同参数连续出现 N 次
  if (recent.length >= MAX_CONSECUTIVE_SAME) {
    const last = recent[recent.length - 1];
    let consecutive = 1;
    for (let i = recent.length - 2; i >= 0; i--) {
      if (recent[i].name === last.name && recent[i].fingerprint === last.fingerprint) {
        consecutive++;
      } else {
        break;
      }
    }
    if (consecutive >= MAX_CONSECUTIVE_SAME) {
      if (tracker.softWarned) {
        return { action: 'hard_stop', name: last.name, fingerprint: last.fingerprint, isError: false };
      }
      return { action: 'soft_warn', name: last.name, fingerprint: last.fingerprint };
    }
  }

  // 2. 多工具模式重复检测：工具序列 [A, B] 或 [A, B, C] 重复出现
  for (let patternLen = Math.min(MAX_PATTERN_LEN, Math.floor(recent.length / 2)); patternLen >= 2; patternLen--) {
    const pattern = recent.slice(-patternLen);
    const patternKey = pattern.map(c => `${c.name}::${c.fingerprint}`).join(' | ');

    let repeats = 1;
    for (let i = recent.length - patternLen - patternLen; i >= 0; i -= patternLen) {
      const segment = recent.slice(i, i + patternLen);
      const segmentKey = segment.map(c => `${c.name}::${c.fingerprint}`).join(' | ');
      if (segmentKey === patternKey) {
        repeats++;
      } else {
        break;
      }
    }

    if (repeats >= MIN_PATTERN_REPEATS) {
      const names = [...new Set(pattern.map(c => c.name))].join('+');
      if (tracker.softWarned) {
        return { action: 'hard_stop', name: names, fingerprint: patternKey, isError: false };
      }
      return { action: 'soft_warn', name: names, fingerprint: patternKey };
    }
  }

  // 3. 连续失败检测
  if (tracker.lastErrorCount >= MAX_CONSECUTIVE_ERRORS) {
    if (tracker.softWarned) {
      return { action: 'hard_stop', name: tracker.lastErrorName, fingerprint: '', isError: true };
    }
    return { action: 'soft_warn', name: tracker.lastErrorName, fingerprint: '' };
  }

  // 4. 同一工具高频调用检测（参数大多重复时才触发）
  if (recent.length >= LOOP_WINDOW) {
    const toolFreq = new Map<string, number>();
    for (const c of recent) {
      toolFreq.set(c.name, (toolFreq.get(c.name) ?? 0) + 1);
    }
    for (const [name, count] of toolFreq) {
      if (count >= LOOP_WINDOW * HIGH_FREQ_THRESHOLD) {
        const uniqueFps = new Set(recent.filter(c => c.name === name).map(c => c.fingerprint)).size;
        if (uniqueFps > count * 0.5) continue;
        if (tracker.softWarned) {
          return { action: 'hard_stop', name, fingerprint: '', isError: false };
        }
        return { action: 'soft_warn', name, fingerprint: '' };
      }
    }
  }

  return { action: 'none' };
}

function isContextOverflowError(err: any): boolean {
  const msg = err?.message ?? '';
  return /context.window.exceeds.limit|token.*limit.*exceeded|maximum.*context.*length/i.test(msg);
}

function isOrphanToolError(err: any): boolean {
  const msg = err?.message ?? '';
  return /tool.result.*tool.id.*not found|tool_call_id.*not found|tool call result does not follow tool call|insufficient.*tool.*messages.*following.*tool_calls/i.test(msg);
}

function extractToolError(result: string): string | undefined {
  try {
    const parsed = JSON.parse(result);
    if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) return undefined;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error === 'string') return error;
    return JSON.stringify(error);
  } catch {
    return undefined;
  }
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
  const telemetryUserQuestion = images?.length
    ? `[包含${images.length}张图片] ${userInput}`
    : userInput;
  startTurn(telemetrySessionId, telemetryAgentId, telemetryUserQuestion);

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

  async function finalSynthesis(
    currentResponse: CreateMessageResult,
    interruptReason: string,
    trace: ToolTrace[],
    round: number,
  ): Promise<CreateMessageResult> {
    // 1. Push the current assistant response (which contains tool_use blocks)
    history.push({ role: 'assistant', content: currentResponse.content });

    // 2. Pair each tool_use with a dummy tool_result to keep message pairs valid
    const dummyResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of currentResponse.content) {
      if (block.type === 'tool_use') {
        dummyResults.push({ type: 'tool_result', tool_use_id: block.id, content: '（已中断）' });
      }
    }
    if (dummyResults.length > 0) {
      history.push({ role: 'user', content: dummyResults });
    }

    // 3. Inject synthesis prompt
    const synthPrompt = [
      `你之前调用的工具已被系统中断（原因：${interruptReason}）。`,
      '请不要再尝试调用任何工具。基于上面对话中已经获取到的所有工具结果，直接回答用户的问题。',
      '如果信息不完整，在回答中说明哪些信息尚缺即可。',
    ].join('\n');
    history.push({ role: 'user', content: synthPrompt });

    // 4. Call LLM without tools to force a text-only response
    const synthParams: CreateMessageParams = {
      model: agent?.model ?? (agentProviderOverride?.defaultModel ?? getModelName()),
      max_tokens: 4096,
      system: systemPrompt,
      tools: [],
      messages: history,
    };

    try {
      const { result: synthResponse } = await callLLM(synthParams, streamEnabled, showThinkingOpt, agentProviderOverride, onTextChunk, onProgress);
      recordLLM(telemetrySessionId, {
        round: round + 1,
        model: agentProviderOverride?.defaultModel ?? getModelName(),
        input_tokens: synthResponse.usage?.input_tokens ?? 0,
        output_tokens: synthResponse.usage?.output_tokens ?? 0,
        stop_reason: synthResponse.stop_reason,
        duration_ms: 0,
      });

      // 5. Append tool stats footnote to the text response
      const footnote = buildToolStatsFootnote(trace);
      const hasText = synthResponse.content.some(
        (b: any) => b.type === 'text' && b.text?.trim(),
      );

      if (!hasText) {
        log.warn(`${logPrefix}最终总结 LLM 返回空文本，回退到静态摘要`);
        const fallbackText = buildInterruptedSummary({
          kind: 'max_rounds', limit: MAX_TOOL_ROUNDS, trace, reason: interruptReason,
        });
        return {
          ...synthResponse,
          content: [{ type: 'text', text: fallbackText + footnote } as any],
          stop_reason: 'end_turn',
        };
      }

      const newContent = synthResponse.content.map(block => {
        if (block.type === 'text') {
          return { ...block, text: block.text + footnote };
        }
        return block;
      });

      return { ...synthResponse, content: newContent, stop_reason: 'end_turn' };
    } catch (err: any) {
      log.warn(`${logPrefix}最终总结 LLM 调用失败 (${err.message})，回退到静态摘要`);
      const fallbackText = buildInterruptedSummary({
        kind: 'max_rounds',
        limit: MAX_TOOL_ROUNDS,
        trace,
        reason: interruptReason,
      });
      return {
        ...currentResponse,
        content: [{ type: 'text', text: fallbackText, citations: null } as any],
        stop_reason: 'end_turn',
      };
    }
  }

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
  let wasInterrupted = false;
  const loopTracker = initLoopTracker();
  const toolTrace: ToolTrace[] = [];
  let devtoolsCallCount = 0;
  while (response.stop_reason === 'tool_use') {
    throwIfAborted();

    if (round > MAX_TOOL_ROUNDS) {
      log.warn(`${logPrefix}达到最大工具调用轮次 (${MAX_TOOL_ROUNDS})，停止`);
      const reason = `工具调用已达上限 ${MAX_TOOL_ROUNDS} 轮`;
      response = await finalSynthesis(response, reason, toolTrace, round);
      wasInterrupted = true;
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
        const resultError = extractToolError(result);
        if (resultError) toolError = resultError;
        const tracePreview = compactToolResult(result, toolError);
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
          input: JSON.stringify(block.input).slice(0, 500),
          output_preview: result.slice(0, 300),
        });
        onProgress?.({ type: 'tool_end', name: block.name, result, round, durationMs: toolDuration });
        toolTrace.push({
          round,
          name: block.name,
          success: !toolError,
          durationMs: toolDuration,
          preview: tracePreview,
          error: toolError ? truncateText(toolError, 240) : undefined,
        });
        if (showThinkingOpt) {
          const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
          log.dim(`${logPrefix}   结果: ${preview}`);
        }
        // Track consecutive errors for loop detection
        if (toolError) {
          if (loopTracker.lastErrorName === block.name) {
            loopTracker.lastErrorCount++;
          } else {
            loopTracker.lastErrorName = block.name;
            loopTracker.lastErrorCount = 1;
          }
        } else {
          loopTracker.lastErrorName = '';
          loopTracker.lastErrorCount = 0;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        if (block.name.startsWith('mcp_devtools_')) devtoolsCallCount++;
      }
    }

    // Record fingerprints for this round and check for loops
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        if (STATE_MUTATING_TOOLS.has(block.name)) loopTracker.stateVersion++;
        const fp = STATE_DEPENDENT_TOOLS.has(block.name)
          ? `${fingerprint(block.input)}::sv${loopTracker.stateVersion}`
          : fingerprint(block.input);
        loopTracker.calls.push({ name: block.name, fingerprint: fp, round });
      }
    }
    const loop = detectLoop(loopTracker);
    if (loop.action === 'soft_warn') {
      log.warn(`${logPrefix}检测到循环: ${loop.name} 重复调用，注入自我反思提示`);
      const sameParams = loop.fingerprint !== '';
      const warnMsg = loop.name.includes('+')
        ? `⚠️ 系统检测到你最近重复执行相同的工具序列 "${loop.name}"${sameParams ? ' 且参数相同' : ''}，但结果无明显进展。请停止这个模式，基于当前已有的信息直接给出答复。如果确实无法完成任务，请说明原因。`
        : `⚠️ 系统检测到你${sameParams ? '连续' : '高频'}调用了 "${loop.name}"${sameParams ? ' 且参数相同' : '（参数不同但方向重复）'}，但结果无明显进展。请停止使用这个工具，基于当前已有的信息直接给出答复。如果确实无法完成任务，请说明原因。`;
      history.push({ role: 'user', content: [{ type: 'text', text: warnMsg, citations: null } as any] });
      loopTracker.softWarned = true;
    } else if (loop.action === 'hard_stop') {
      log.warn(`${logPrefix}循环未终止，强制停止`);
      const reason = loop.isError
        ? `工具 "${loop.name}" 连续 ${MAX_CONSECUTIVE_ERRORS} 次执行失败`
        : loop.fingerprint
          ? (loop.name.includes('+')
            ? `工具序列 "${loop.name}" 重复执行，参数相同`
            : `工具 "${loop.name}" 连续调用，参数相同`)
          : `工具 "${loop.name}" 高频调用（参数不同但方向重复）`;
      response = await finalSynthesis(response, reason, toolTrace, round);
      wasInterrupted = true;
      break;
    }

    // DevTools budget: prevent browser tools from consuming the entire tool budget
    if (devtoolsCallCount === MAX_DEVTOOLS_ROUNDS) {
      log.warn(`${logPrefix}DevTools 工具调用达到上限 (${MAX_DEVTOOLS_ROUNDS})，注入停止提示`);
      const warnMsg = `⚠️ 浏览器工具已累计调用 ${MAX_DEVTOOLS_ROUNDS} 次。请立即停止使用所有浏览器工具（mcp_devtools_*），基于当前已获取的信息直接给出答复。如果信息不足，请说明原因。`;
      history.push({ role: 'user', content: [{ type: 'text', text: warnMsg, citations: null } as any] });
    } else if (devtoolsCallCount > MAX_DEVTOOLS_ROUNDS) {
      log.warn(`${logPrefix}DevTools 预算已耗尽，强制停止`);
      const reason = `浏览器工具累计调用 ${devtoolsCallCount} 次，超出上限 ${MAX_DEVTOOLS_ROUNDS}`;
      response = await finalSynthesis(response, reason, toolTrace, round);
      wasInterrupted = true;
      break;
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

  if (wasInterrupted) {
    history.length = historyLenBefore;
    if (processedImages && processedImages.length > 0) {
      const contentBlocks: any[] = [];
      for (const img of processedImages) {
        contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      }
      contentBlocks.push({ type: 'text', text: processedInput });
      history.push({ role: 'user', content: contentBlocks });
    } else {
      history.push({ role: 'user', content: processedInput });
    }
  }
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
