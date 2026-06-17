/**
 * dream-analyze.ts
 * Analyzes daily telemetry data per agent, calls LLM to synthesize tool usage lessons,
 * and writes consolidated dream files for prompt injection.
 */
import fs from 'fs';
import { resolve } from 'path';
import { getDb } from '../db/connection.js';
import { getDreamProvider } from '../llm/provider.js';
import { getAllAgents } from '../llm/agents/config.js';
import { log } from '../utils/logger.js';
import type { TelemetryToolCall } from '../telemetry/types.js';

const DREAM_WARN_LENGTH = 6000;
const DREAM_MIN_LENGTH = 200;
const DREAM_MIN_SECTION_COUNT = 1;
const DREAM_MAX_SHRINK_RATIO = 0.35;
const DREAM_MAX_SHRINK_FLOOR = 800;
const DREAM_MAX_TOKENS = 4000;
const DREAM_RETRY_MAX_TOKENS = 6000;
const DREAM_COMPLETE_MARKER = '<!-- DREAM_COMPLETE -->';
const warnedInvalidDreamFiles = new Set<string>();

const TOKEN_LIMIT_STOP_REASONS = new Set(['max_tokens', 'length']);
const RETRYABLE_VALIDATION_REASONS = new Set([
  '模型输出触达 token 上限',
  '缺少完成标记',
  '代码块未闭合',
  '最后一个工具分节不完整',
  '最后一行疑似未完成',
  '疑似截断结尾',
]);

function getDreamsDir(): string {
  return resolve(process.cwd(), 'data/dreams');
}

function warnInvalidDreamOnce(key: string, message: string): void {
  if (warnedInvalidDreamFiles.has(key)) return;
  warnedInvalidDreamFiles.add(key);
  log.warn(message);
}

/**
 * Remove characters that can break JSON serialisation for some LLM APIs (e.g. DeepSeek).
 * - Control chars (except \n \r \t)
 * - Lone surrogates
 * - Bare backslash-x / backslash-u sequences that confuse strict JSON parsers
 */
function sanitizeForLLM(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF]/g, '')
    .replace(/\\x(?![0-9a-fA-F]{2})/g, 'x')
    .replace(/\\u(?![0-9a-fA-F]{4})/g, 'u');
}

export interface DreamTurnSummary {
  agent_id: string;
  channel: string;
  loop_rounds: number;
  total_tool_calls: number;
  tools: TelemetryToolCall[];
  answer_preview: string;
  model: string;
}

/** Load the latest valid dream file for an agent (new dir format, with flat-file fallback) */
export function loadDreamFile(agentName: string): string {
  const agentDir = resolve(getDreamsDir(), agentName);
  if (fs.existsSync(agentDir) && fs.statSync(agentDir).isDirectory()) {
    const files = fs.readdirSync(agentDir)
      .filter(f => f.endsWith('.md'))
      .sort();
    for (let i = files.length - 1; i >= 0; i--) {
      const content = fs.readFileSync(resolve(agentDir, files[i]), 'utf-8');
      const validation = validateDream(content);
      if (validation.pass) return content;
      warnInvalidDreamOnce(`${agentName}/${files[i]}`, `[dream] ${agentName}: 跳过无效 dream 文件 ${files[i]} [${validation.reasons.join('; ')}]`);
    }
  }
  const legacyPath = resolve(getDreamsDir(), `${agentName}.md`);
  if (fs.existsSync(legacyPath)) {
    const content = fs.readFileSync(legacyPath, 'utf-8');
    const validation = validateDream(content);
    if (validation.pass) return content;
    warnInvalidDreamOnce(`${agentName}/legacy`, `[dream] ${agentName}: 跳过无效 legacy dream [${validation.reasons.join('; ')}]`);
  }
  return '';
}

/** Write dream content for an agent under dated subdirectory */
function writeDreamFile(agentName: string, dateStr: string, content: string): void {
  const agentDir = resolve(getDreamsDir(), agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  const filePath = resolve(agentDir, `${dateStr}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  if (content.length > DREAM_WARN_LENGTH) {
    log.warn(`[dream] ${agentName}: dream 过长 (${content.length} 字符)，可能影响 system prompt 上下文窗口`);
  }
}

/** Query telemetry_turn rows for a given date range and agent */
function queryTelemetry(agentId: string, dateStr: string): DreamTurnSummary[] {
  const db = getDb();
  const dayStart = new Date(`${dateStr}T00:00:00+08:00`).getTime();
  const dayEnd = new Date(`${dateStr}T23:59:59+08:00`).getTime();

  const rows = db.prepare(`
    SELECT agent_id, channel, loop_rounds, total_tool_calls,
           tools_json, answer_preview, model
    FROM telemetry_turn
    WHERE agent_id = ? AND started_at >= ? AND started_at <= ?
    ORDER BY started_at
  `).all(agentId, dayStart, dayEnd) as Array<{
    agent_id: string;
    channel: string;
    loop_rounds: number;
    total_tool_calls: number;
    tools_json: string;
    answer_preview: string;
    model: string;
  }>;

  return rows.map(r => ({
    agent_id: r.agent_id,
    channel: r.channel,
    loop_rounds: r.loop_rounds,
    total_tool_calls: r.total_tool_calls,
    tools: JSON.parse(r.tools_json || '[]'),
    answer_preview: r.answer_preview,
    model: r.model,
  }));
}

/** Format a single tool call as a replay line */
function formatToolCall(tc: TelemetryToolCall): string {
  const status = tc.success ? '✓' : '✗';
  const input = tc.input ?? tc.name;
  const output = !tc.success && tc.error
    ? tc.error.slice(0, 120)
    : (tc.output_preview?.slice(0, 120) ?? '');
  return `  ${tc.name}(${input.slice(0, 200)}) → ${output} ${status}`;
}

/** Build a turn-by-turn replay of tool interactions for LLM analysis */
function buildToolUsageSummary(turns: DreamTurnSummary[]): string {
  if (turns.length === 0) return '';

  const lines: string[] = [];
  const interestingTurns = turns.filter(
    t => t.loop_rounds > 3 || t.tools.some(tc => !tc.success),
  );
  const simpleTurns = turns.filter(
    t => t.loop_rounds <= 3 && t.tools.every(tc => tc.success),
  );

  if (interestingTurns.length > 0) {
    lines.push('=== 有探索/失败的交互（重点分析） ===');
    for (const t of interestingTurns.slice(0, 8)) {
      const question = t.answer_preview
        ? `用户场景: ${t.answer_preview.slice(0, 80)}`
        : `(${t.loop_rounds}轮交互)`;
      lines.push('');
      lines.push(`[Turn] ${question}`);
      for (const tc of t.tools) {
        lines.push(formatToolCall(tc));
      }
    }
  }

  if (simpleTurns.length > 0) {
    lines.push('');
    lines.push('=== 顺利完成的交互（参考） ===');
    for (const t of simpleTurns.slice(0, 5)) {
      const chain = t.tools.map(tc => tc.name).join(' → ');
      lines.push(`- ${chain}`);
    }
  }

  return lines.join('\n');
}

const DREAM_SYSTEM_PROMPT = `你是一个 AI 系统的"梦境分析器"。你的任务是从 agent 的工具调用回放数据中，提炼出可长期复用的工具使用经验。

## 核心原则

你提炼的是**永久适用的经验法则**，不是当日流水账。每条经验必须让未来的 agent 看到后能直接避坑或复用高效路径。

## 输出格式

- 中文，markdown，以 "## 工具使用经验" 开头
- 按工具名或工具组合分小节（### tool_name 或 ### tool_a + tool_b）
- 每条经验包含"场景 → 正确做法"的因果结构
- 总字数控制在 4000 字以内
- 最后一行必须输出完成标记：${DREAM_COMPLETE_MARKER}

## 重点提炼

- 从失败→成功的探索路径中总结：参数该怎么填、什么顺序调用最高效、遇到什么错误该怎么降级
- 高效的 tool chain 组合模式（如"先 list 再 query"、"先 memory 后 knowledge"）
- 常见的参数陷阱和修正策略（如名称映射、日期格式、字段选择）
- 什么情况下应该停止重试、转向备选方案

## 严格禁止

- 禁止出现具体延时数值（如"7ms"、"2s"、"平均耗时"等）
- 禁止出现调用次数（如"4次调用"、"零失败"、"成功率100%"等运营指标）
- 禁止使用"今日"、"今天"、"本日"、"本次"等时效性措辞
- 禁止写空泛的描述（如"响应快速，适合高频场景"），必须有具体的场景和做法

## 合并策略（新数据优先）

- 当新回放数据中的工具使用模式与旧经验矛盾时，以新数据为准，删除或改写旧经验
- 新数据揭示了旧经验未覆盖的场景时，新增对应经验条目
- 旧经验中没有被新数据涉及的工具，原样保留
- 新数据验证了旧经验正确的，保留但可精简措辞
- 严禁因为旧经验篇幅大就原样照搬——每条经验都必须经受新数据的检验`;

function countDreamSections(text: string): number {
  return (text.match(/^###\s+/gm) ?? []).length;
}

function stripDreamCompletionMarker(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith(DREAM_COMPLETE_MARKER)
    ? trimmed.slice(0, -DREAM_COMPLETE_MARKER.length).trim()
    : trimmed;
}

function hasCompletionMarker(text: string): boolean {
  return text.trim().endsWith(DREAM_COMPLETE_MARKER);
}

function hasUnclosedCodeFence(text: string): boolean {
  return ((text.match(/```/g) ?? []).length % 2) !== 0;
}

function hasUnbalancedBrackets(line: string): boolean {
  const pairs: Array<[string, string]> = [
    ['(', ')'],
    ['（', '）'],
    ['[', ']'],
    ['【', '】'],
    ['{', '}'],
    ['《', '》'],
  ];

  return pairs.some(([open, close]) => {
    const opens = line.split(open).length - 1;
    const closes = line.split(close).length - 1;
    return opens > closes;
  });
}

function hasIncompleteTrailingSyntax(text: string): boolean {
  const lines = text.trim().split('\n').map(line => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (!last) return true;
  if (/^[-*+]\s*$/.test(last) || /^\d+\.\s*$/.test(last)) return true;
  if (/[，,、：:；;（(\[【{《“‘-]$/.test(last)) return true;
  if (/(?:和|或|与|及|以及|并|且|但|如果|因为|所以|例如|如|从|把|将|为)$/.test(last)) return true;
  if (((last.match(/`/g) ?? []).length % 2) !== 0) return true;
  return hasUnbalancedBrackets(last);
}

function endsLikeCompleteMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /[。！？.!?）)\]】`"']$/.test(trimmed);
}

function getDreamSections(text: string): string[] {
  return text.split(/^###\s+/m).slice(1);
}

function hasIncompleteLastSection(text: string): boolean {
  const sections = getDreamSections(text);
  const last = sections[sections.length - 1]?.trim() ?? '';
  if (!last) return true;
  const bodyLines = last.split('\n').slice(1).map(line => line.trim()).filter(Boolean);
  if (bodyLines.length === 0) return true;
  return !/场景(?:\*\*)?\s*[：:]/.test(last) || !/正确做法(?:\*\*)?\s*[：:]/.test(last);
}

function hasSectionMissingRequiredStructure(text: string): boolean {
  return getDreamSections(text).some(section =>
    !/场景(?:\*\*)?\s*[：:]/.test(section) || !/正确做法(?:\*\*)?\s*[：:]/.test(section),
  );
}

function isTokenLimitStopReason(stopReason: string | undefined): boolean {
  return TOKEN_LIMIT_STOP_REASONS.has((stopReason ?? '').toLowerCase());
}

/** Validate dream output quality before writing or prompt injection */
export function validateDream(
  text: string,
  options: {
    existingDream?: string;
    requireCompletionMarker?: boolean;
    stopReason?: string;
    strictSections?: boolean;
  } = {},
): { pass: boolean; reasons: string[]; retryable: boolean } {
  const reasons: string[] = [];
  const trimmed = stripDreamCompletionMarker(text);
  if (isTokenLimitStopReason(options.stopReason)) reasons.push('模型输出触达 token 上限');
  if (options.requireCompletionMarker && !hasCompletionMarker(text)) reasons.push('缺少完成标记');
  if (trimmed.length < DREAM_MIN_LENGTH) reasons.push(`内容过短(${trimmed.length}字符)`);
  if (/\d+\s*ms\b/i.test(text)) reasons.push('包含延时数值(ms)');
  if (/\d+\s*[次秒s]\s*(调用|失败|成功)/i.test(text)) reasons.push('包含调用次数统计');
  if (/今[日天]|本[日次]/.test(text)) reasons.push('包含时效性措辞');
  if (!trimmed.startsWith('## 工具使用经验')) reasons.push('缺少标准开头');
  if (countDreamSections(trimmed) < DREAM_MIN_SECTION_COUNT) reasons.push('缺少工具分节');
  if (!/场景(?:\*\*)?\s*[：:]/.test(trimmed)) reasons.push('缺少场景结构');
  if (!/正确做法(?:\*\*)?\s*[：:]/.test(trimmed)) reasons.push('缺少正确做法结构');
  if (hasUnclosedCodeFence(trimmed)) reasons.push('代码块未闭合');
  if (options.strictSections) {
    if (hasIncompleteLastSection(trimmed)) reasons.push('最后一个工具分节不完整');
    if (hasIncompleteTrailingSyntax(trimmed)) reasons.push('最后一行疑似未完成');
    if (hasSectionMissingRequiredStructure(trimmed)) reasons.push('工具分节缺少场景或正确做法');
  } else if (!endsLikeCompleteMarkdown(trimmed)) {
    reasons.push('疑似截断结尾');
  }

  const existing = options.existingDream?.trim();
  if (existing && existing.length >= 1200) {
    const minLength = Math.max(DREAM_MAX_SHRINK_FLOOR, Math.floor(existing.length * DREAM_MAX_SHRINK_RATIO));
    if (trimmed.length < minLength) {
      reasons.push(`相对历史版本异常缩水(${trimmed.length}/${existing.length}字符)`);
    }
  }

  return {
    pass: reasons.length === 0,
    reasons,
    retryable: reasons.some(reason => RETRYABLE_VALIDATION_REASONS.has(reason)),
  };
}

function buildDreamSystemPrompt(retry: boolean): string {
  if (!retry) return DREAM_SYSTEM_PROMPT;
  return `${DREAM_SYSTEM_PROMPT}

## 重试要求

上一轮输出疑似被截断。请压缩历史经验，只保留最可复用的规则，必须完整输出并以 ${DREAM_COMPLETE_MARKER} 作为最后一行。`;
}

function extractDreamText(result: { content: any[] }): string {
  const textBlocks = result.content.filter(b => b.type === 'text');
  return textBlocks.map(b => (b as any).text).join('\n').trim();
}

/** Run dream analysis for a single agent */
export async function runDreamForAgent(agentId: string, agentName: string, dateStr: string): Promise<boolean> {
  const turns = queryTelemetry(agentId, dateStr);
  if (turns.length === 0) {
    log.file(`[dream] ${agentName}: 无数据，跳过`);
    return false;
  }

  const summary = buildToolUsageSummary(turns);
  const existingDream = loadDreamFile(agentName);

  const userMessage = sanitizeForLLM([
    `数据日期: ${dateStr}`,
    `Agent: ${agentName}`,
    '',
    '--- 工具使用回放 ---',
    summary,
    '',
    existingDream ? `--- 现有经验（以下为历史版本，新回放数据与之矛盾时必须以新数据为准） ---\n${existingDream}` : '（暂无历史经验，请从头总结）',
  ].join('\n'));

  try {
    const { provider, model } = getDreamProvider();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await provider.createMessage({
        model,
        max_tokens: attempt === 0 ? DREAM_MAX_TOKENS : DREAM_RETRY_MAX_TOKENS,
        system: buildDreamSystemPrompt(attempt > 0),
        tools: [],
        messages: [{ role: 'user', content: userMessage }],
      });

      const dreamText = extractDreamText(result);
      if (!dreamText) continue;

      const validation = validateDream(dreamText, {
        existingDream,
        requireCompletionMarker: true,
        stopReason: result.stop_reason,
        strictSections: true,
      });
      if (!validation.pass) {
        const detail = validation.reasons.join('; ');
        if (attempt === 0 && validation.retryable) {
          log.warn(`[dream] ${agentName}: 质量检测未通过 [${detail}]，准备重试一次`);
          continue;
        }
        log.warn(`[dream] ${agentName}: 质量检测未通过 [${detail}]，跳过写入`);
        return false;
      }
      const dreamContent = stripDreamCompletionMarker(dreamText);
      writeDreamFile(agentName, dateStr, dreamContent);
      log.file(`[dream] ${agentName}: 已生成 dream (${dreamContent.length} 字符)`);
      return true;
    }
  } catch (err: any) {
    log.error(`[dream] ${agentName}: LLM 调用失败: ${err.message}`);
  }

  return false;
}

/** Run dream for all agents with telemetry data on a given date */
export async function runDreamForAll(dateStr: string): Promise<void> {
  const agents = getAllAgents();
  log.file(`[dream] 开始每日回顾: ${dateStr}, ${agents.length} 个 agent`);

  for (const agent of agents) {
    await runDreamForAgent(agent.id, agent.name, dateStr);
  }

  log.file(`[dream] 每日回顾完成: ${dateStr}`);
}
