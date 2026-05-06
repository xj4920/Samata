/**
 * analyze-log.ts
 * 解析 Samata 日志文件，提取所有渠道的用户提问记录并输出统计报告。
 *
 * 支持渠道：企微(wework)、飞书(feishu)、Telegram、CLI
 *
 * 用法：
 *   npx tsx scripts/analyze-log.ts                                            # 今天
 *   npx tsx scripts/analyze-log.ts logs/app-2026-04-12.log                    # 指定文件
 *   npx tsx scripts/analyze-log.ts --from=2026-04-10 --to=2026-04-15         # 日期范围
 *   npx tsx scripts/analyze-log.ts --channel=feishu                           # 只看飞书
 *   npx tsx scripts/analyze-log.ts --channel=wework --from=2026-04-10 --csv  # 组合
 *
 * 分析结果以 markdown 写入 ./logs/daily_usage/<date>.md
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const nodeRequire = createRequire(import.meta.url);

type Channel = 'wework' | 'feishu' | 'telegram' | 'cli';
type DataSource = 'auto' | 'telemetry' | 'app';
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
type LatencyMode = 'precise' | 'best_effort' | 'missing';
type ActorEventKind = 'tool_start' | 'tool_result' | 'thinking' | 'error' | 'other';

interface TelemetryJsonTurn {
  turn_id: string; session_id: string; user_id: string; agent_id: string;
  channel: string; started_at: number; ended_at: number;
  ctx_ms: number; llm_total_ms: number; tool_total_ms: number; render_ms: number;
  loop_rounds: number; total_tool_calls: number; stop_reason: string;
  model: string; input_tokens: number; output_tokens: number;
  tools: { name: string; round: number; duration_ms: number; success: boolean; bytes: number; error?: string }[];
  llm_calls: { round: number; model: string; input_tokens: number; output_tokens: number; stop_reason: string; duration_ms: number }[];
  knowledge_hits: { keyword: string; hits: number; agent_id: string }[];
  answer_preview: string;
}

interface UserMessage {
  time: string;
  userid: string;
  channel: Channel;
  chattype: string;
  msgtype: string;
  agent: string;
  content: string;
}

interface ToolCall {
  name: string;
  durationMs?: number;
  round?: number;
}

interface TurnRecord extends UserMessage {
  startIso: string;
  actorKey?: string;
  traceId?: string;
  toolCalls: ToolCall[];
  toolCount: number;
  latencyMode: LatencyMode;
  latencyMs?: number;
  latencySource?: string;
  endIso?: string;
  failed: boolean;
  // Telemetry-only extensions (undefined when parsed from app logs)
  inputTokens?: number;
  outputTokens?: number;
  ctxMs?: number;
  llmTotalMs?: number;
  toolTotalMs?: number;
  renderMs?: number;
  loopRounds?: number;
  stopReason?: string;
  knowledgeHitsTotal?: number;
  knowledgeZeroHitCount?: number;
  toolSuccessCount?: number;
  toolFailCount?: number;
  model?: string;
}

interface FeishuBlock {
  isoTime: string;
  appName: string;
  traceId: string;
  fields: Map<string, string>;
}

interface FeishuCompletion {
  isoTime: string;
  elapsedMs?: number;
  toolsDeclared: number;
  toolCalls: ToolCall[];
}

interface ActorEvent {
  isoTime: string;
  actorKey: string;
  kind: ActorEventKind;
  toolName?: string;
  level: LogLevel;
}

interface ToolAggregate {
  calls: number;
  sessions: number;
  channels: Map<Channel, number>;
}

// --- wework: cmd=aibot_msg_callback ---
const WEWORK_LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*cmd=aibot_msg_callback.*body=(\{.+)$/;
const CMD_PREFIX_RE = /^\//;
const AT_BOT_RE = /^@\S+\s*/;

// --- feishu: 多行 block ---
const FEISHU_RECV_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[INFO\] \[飞书:([^\]]+)\]\[([^\]]+)\] 收到消息$/;
const FEISHU_CHAT_START_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[INFO\] \[飞书:([^\]]+)\]\[([^\]]+)\] AI 对话开始$/;
const FEISHU_CHAT_END_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[INFO\] \[飞书:([^\]]+)\]\[([^\]]+)\] AI 对话完成$/;
const FEISHU_DETAIL_RE = /^\s{2,}(\w+)=(.+)$/;

// --- telegram ---
const TG_LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[DEBUG\] \[TG\] (\S+): (.+)$/;

// --- per-actor logs ---
const WEWORK_ACTOR_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[(DEBUG|INFO|WARN|ERROR)\] \[企微:[^:\]]+:([^\]]+)\] (.+)$/;
const TG_ACTOR_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[(DEBUG|INFO|WARN|ERROR)\] \[TG:([^\]]+)\] (.+)$/;
const TOOL_START_RE = /^🔧 调用工具: (.+)$/;

function toUTC8(iso: string): string {
  const ms = new Date(iso).getTime() + 8 * 3600_000;
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${hh}:${mm}:${ss}`;
}

function parseArg(args: string[], prefix: string): string | undefined {
  const hit = args.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function enumerateDateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function resolveLogPaths(args: string[], source: DataSource): { paths: string[]; source: DataSource } {
  const root = process.cwd();
  const filePath = args.find(a => !a.startsWith('--'));
  if (filePath) {
    const p = resolve(root, filePath);
    if (!existsSync(p)) {
      console.error(`文件不存在: ${p}`);
      process.exit(1);
    }
    const detected = p.includes('telemetry') ? 'telemetry' : 'app';
    return { paths: [p], source: source === 'auto' ? detected : source };
  }

  const fromDate = parseArg(args, '--from=');
  const toDate = parseArg(args, '--to=');

  const today = new Date();
  today.setHours(today.getHours() + 8);
  const todayStr = today.toISOString().slice(0, 10);
  const from = fromDate || todayStr;
  const to = toDate || todayStr;
  const dates = enumerateDateRange(from, to);

  // Auto-detect: prefer telemetry over app log
  if (source === 'auto') {
    const telemPaths = dates
      .map(d => join(root, 'logs', `telemetry-${d}.jsonl`))
      .filter(p => existsSync(p));
    if (telemPaths.length > 0) return { paths: telemPaths, source: 'telemetry' as DataSource };
    const appPaths = dates
      .map(d => join(root, 'logs', `app-${d}.log`))
      .filter(p => existsSync(p));
    if (appPaths.length > 0) return { paths: appPaths, source: 'app' as DataSource };
    console.error(`日期范围 ${from} ~ ${to} 内无 telemetry 或 app 日志文件`);
    process.exit(1);
    return { paths: [], source: 'app' };
  }

  const suffix = source === 'telemetry' ? 'telemetry' : 'app';
  const ext = source === 'telemetry' ? '.jsonl' : '.log';
  const paths = dates
    .map(d => join(root, 'logs', `${suffix}-${d}${ext}`))
    .filter(p => existsSync(p));
  if (paths.length === 0) {
    console.error(`日期范围 ${from} ~ ${to} 内无 ${suffix} 日志文件`);
    process.exit(1);
  }
  return { paths, source };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function sanitizeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatMs(ms?: number): string {
  if (ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function parseDurationMs(raw?: string): number | undefined {
  if (!raw) return undefined;
  const m = /^(\d+)ms$/.exec(raw.trim());
  return m ? Number(m[1]) : undefined;
}

function diffMs(startIso: string, endIso: string): number | undefined {
  const diff = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Number.isFinite(diff) && diff >= 0 ? diff : undefined;
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((sum, cur) => sum + cur, 0) / values.length);
}

function extractWeworkContent(body: any): { msgtype: string; content: string } | null {
  const msgtype: string = body.msgtype;

  if (msgtype === 'text') {
    return { msgtype, content: body.text?.content ?? '' };
  }
  if (msgtype === 'image') {
    return { msgtype, content: '[图片消息]' };
  }
  if (msgtype === 'mixed') {
    const items: any[] = body.mixed?.msg_item ?? [];
    const parts: string[] = [];
    for (const item of items) {
      if (item.msgtype === 'text') parts.push(item.text?.content ?? '');
      else if (item.msgtype === 'image') parts.push('[图片]');
      else parts.push(`[${item.msgtype}]`);
    }
    return { msgtype, content: parts.join(' ') };
  }
  return null;
}

function parseWeworkTurn(line: string): TurnRecord | null {
  const m = WEWORK_LINE_RE.exec(line);
  if (!m) return null;

  const [, isoTime, jsonStr] = m;
  let body: any;
  try {
    body = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  const extracted = extractWeworkContent(body);
  if (!extracted) return null;

  let { content } = extracted;
  if (body.chattype === 'group') content = content.replace(AT_BOT_RE, '');
  if (CMD_PREFIX_RE.test(content.trim())) return null;
  if (!content.trim()) return null;

  const userid = body.from?.userid ?? 'unknown';
  return {
    time: toUTC8(isoTime),
    startIso: isoTime,
    userid,
    channel: 'wework',
    chattype: body.chattype === 'group' ? '群聊' : '私聊',
    msgtype: extracted.msgtype,
    agent: '',
    content: content.trim(),
    actorKey: `wework:wework_${userid.slice(-6)}`,
    toolCalls: [],
    toolCount: 0,
    latencyMode: 'missing',
    failed: false,
  };
}

function parseFeishuBlock(lines: string[], startIdx: number, re: RegExp): { block: FeishuBlock; endIdx: number } | null {
  const m = re.exec(lines[startIdx]);
  if (!m) return null;

  const [, isoTime, appName, traceId] = m;
  const fields = new Map<string, string>();
  let idx = startIdx + 1;
  while (idx < lines.length) {
    const dm = FEISHU_DETAIL_RE.exec(lines[idx]);
    if (!dm) break;
    fields.set(dm[1], dm[2]);
    idx++;
  }
  return { block: { isoTime, appName, traceId, fields }, endIdx: idx };
}

function parseTelegramTurn(line: string): TurnRecord | null {
  const m = TG_LINE_RE.exec(line);
  if (!m) return null;

  const [, isoTime, username, text] = m;
  if (CMD_PREFIX_RE.test(text.trim())) return null;
  if (!text.trim()) return null;

  return {
    time: toUTC8(isoTime),
    startIso: isoTime,
    userid: username,
    channel: 'telegram',
    chattype: '私聊',
    msgtype: 'text',
    agent: '',
    content: text.trim(),
    actorKey: `telegram:${username}`,
    toolCalls: [],
    toolCount: 0,
    latencyMode: 'missing',
    failed: false,
  };
}

function parseToolCallLine(raw: string): ToolCall | null {
  const m = /^r(\d+)\s+(.+?)(?: \((\d+)ms\))?(?: \| |$)/.exec(raw);
  if (!m) return null;
  return {
    round: Number(m[1]),
    name: m[2],
    durationMs: m[3] ? Number(m[3]) : undefined,
  };
}

function parseFeishuCompletion(block: FeishuBlock): FeishuCompletion {
  const toolCalls: ToolCall[] = [];
  for (const [key, value] of block.fields.entries()) {
    if (!/^tool\d+$/.test(key)) continue;
    const parsed = parseToolCallLine(value);
    if (parsed) toolCalls.push(parsed);
  }
  const toolsDeclared = Number(block.fields.get('tools') ?? toolCalls.length) || toolCalls.length;
  const toolsMore = Number(block.fields.get('tools_more') ?? 0) || 0;
  for (let i = 0; i < toolsMore; i++) {
    toolCalls.push({ name: '（未展开工具）' });
  }
  return {
    isoTime: block.isoTime,
    elapsedMs: parseDurationMs(block.fields.get('elapsed')),
    toolsDeclared,
    toolCalls,
  };
}

function parseActorEvent(line: string): ActorEvent | null {
  const wework = WEWORK_ACTOR_RE.exec(line);
  if (wework) {
    const [, isoTime, levelRaw, username, message] = wework;
    const level = levelRaw as LogLevel;
    const toolMatch = TOOL_START_RE.exec(message.trim());
    return {
      isoTime,
      actorKey: `wework:${username}`,
      level,
      kind: toolMatch ? 'tool_start' : level === 'ERROR' ? 'error' : message.includes('💭') ? 'thinking' : message.includes('结果:') ? 'tool_result' : 'other',
      toolName: toolMatch?.[1]?.trim(),
    };
  }

  const tg = TG_ACTOR_RE.exec(line);
  if (tg) {
    const [, isoTime, levelRaw, username, message] = tg;
    const level = levelRaw as LogLevel;
    const toolMatch = TOOL_START_RE.exec(message.trim());
    return {
      isoTime,
      actorKey: `telegram:${username}`,
      level,
      kind: toolMatch ? 'tool_start' : level === 'ERROR' ? 'error' : message.includes('💭') ? 'thinking' : message.includes('结果:') ? 'tool_result' : 'other',
      toolName: toolMatch?.[1]?.trim(),
    };
  }

  return null;
}

function collectFeishuMeta(rawLines: string[]): {
  feishuAgentMap: Map<string, string>;
  feishuCompletionMap: Map<string, FeishuCompletion>;
} {
  const feishuAgentMap = new Map<string, string>();
  const feishuCompletionMap = new Map<string, FeishuCompletion>();

  for (let i = 0; i < rawLines.length; i++) {
    const startBlock = parseFeishuBlock(rawLines, i, FEISHU_CHAT_START_RE);
    if (startBlock) {
      const agentField = startBlock.block.fields.get('agent') ?? '';
      feishuAgentMap.set(startBlock.block.traceId, agentField);
      i = startBlock.endIdx - 1;
      continue;
    }

    const completionBlock = parseFeishuBlock(rawLines, i, FEISHU_CHAT_END_RE);
    if (completionBlock) {
      feishuCompletionMap.set(completionBlock.block.traceId, parseFeishuCompletion(completionBlock.block));
      i = completionBlock.endIdx - 1;
    }
  }

  return { feishuAgentMap, feishuCompletionMap };
}

function parseAllTurns(rawLines: string[]): TurnRecord[] {
  const turns: TurnRecord[] = [];
  const actorEvents = new Map<string, ActorEvent[]>();
  const { feishuAgentMap, feishuCompletionMap } = collectFeishuMeta(rawLines);

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    const actorEvent = parseActorEvent(line);
    if (actorEvent) {
      const items = actorEvents.get(actorEvent.actorKey) ?? [];
      items.push(actorEvent);
      actorEvents.set(actorEvent.actorKey, items);
    }

    const wework = parseWeworkTurn(line);
    if (wework) {
      turns.push(wework);
      continue;
    }

    const feishuResult = parseFeishuBlock(rawLines, i, FEISHU_RECV_RE);
    if (feishuResult) {
      const { block, endIdx } = feishuResult;
      i = endIdx - 1;

      const text = block.fields.get('text') ?? '';
      if (!text || CMD_PREFIX_RE.test(text.trim())) continue;

      const senderField = block.fields.get('sender') ?? 'unknown';
      const userid = senderField.split(' ')[0] || senderField;
      const chatField = block.fields.get('chat') ?? '';
      const isGroup = block.fields.get('group') === 'true' || chatField.startsWith('group:');
      const agent = feishuAgentMap.get(block.traceId) ?? '';
      const completion = feishuCompletionMap.get(block.traceId);
      const toolCalls = completion?.toolCalls ?? [];
      const toolCount = Math.max(completion?.toolsDeclared ?? toolCalls.length, toolCalls.length);

      turns.push({
        time: toUTC8(block.isoTime),
        startIso: block.isoTime,
        userid,
        channel: 'feishu',
        chattype: isGroup ? '群聊' : '私聊',
        msgtype: 'text',
        agent,
        content: text.trim(),
        traceId: block.traceId,
        toolCalls,
        toolCount,
        latencyMode: completion?.elapsedMs !== undefined ? 'precise' : 'missing',
        latencyMs: completion?.elapsedMs,
        latencySource: completion?.elapsedMs !== undefined ? '飞书 AI 对话完成 elapsed' : undefined,
        endIso: completion?.isoTime,
        failed: false,
      });
      continue;
    }

    const tg = parseTelegramTurn(line);
    if (tg) {
      turns.push(tg);
    }
  }

  applyBestEffortAnalysis(turns, actorEvents);
  turns.sort((a, b) => a.startIso.localeCompare(b.startIso));
  return turns;
}

function parseTelemetryTurns(filePaths: string[]): TurnRecord[] {
  const turns: TurnRecord[] = [];
  let skipped = 0;

  for (const p of filePaths) {
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let t: TelemetryJsonTurn;
      try { t = JSON.parse(line); } catch { skipped++; continue; }

      const totalMs = t.ctx_ms + t.llm_total_ms + t.tool_total_ms + t.render_ms;
      const knowledgeZeroHits = t.knowledge_hits.filter(h => h.hits === 0).length;
      const toolSucceeds = t.tools.filter(tc => tc.success).length;
      const toolFails = t.tools.length - toolSucceeds;
      const userSuffix = t.user_id.slice(-8);

      turns.push({
        time: toUTC8(new Date(t.started_at).toISOString()),
        startIso: new Date(t.started_at).toISOString(),
        userid: `${t.channel}_${userSuffix}`,
        channel: (VALID_CHANNELS.includes(t.channel as Channel) ? t.channel : 'cli') as Channel,
        chattype: t.channel === 'cli' ? 'CLI' : '私聊',
        msgtype: 'text',
        agent: t.agent_id,
        content: t.answer_preview || '(无文本回复)',
        toolCalls: t.tools.map(tc => ({ name: tc.name, durationMs: tc.duration_ms, round: tc.round })),
        toolCount: t.total_tool_calls,
        latencyMode: 'precise',
        latencyMs: totalMs,
        latencySource: 'telemetry 分段耗时合计',
        endIso: new Date(t.ended_at).toISOString(),
        failed: t.stop_reason === 'error' || t.tools.some(tc => !!tc.error),
        actorKey: `${t.channel}:${userSuffix}`,
        // Telemetry extensions
        inputTokens: t.input_tokens,
        outputTokens: t.output_tokens,
        ctxMs: t.ctx_ms,
        llmTotalMs: t.llm_total_ms,
        toolTotalMs: t.tool_total_ms,
        renderMs: t.render_ms,
        loopRounds: t.loop_rounds,
        stopReason: t.stop_reason,
        knowledgeHitsTotal: t.knowledge_hits.reduce((s, h) => s + h.hits, 0),
        knowledgeZeroHitCount: knowledgeZeroHits,
        toolSuccessCount: toolSucceeds,
        toolFailCount: toolFails,
        model: t.model,
      });
    }
  }

  if (skipped > 0) console.warn(`Telemetry: 跳过 ${skipped} 行无法解析的 JSON 行`);
  turns.sort((a, b) => a.startIso.localeCompare(b.startIso));
  return turns;
}

function applyBestEffortAnalysis(turns: TurnRecord[], actorEvents: Map<string, ActorEvent[]>): void {
  const turnsByActor = new Map<string, TurnRecord[]>();
  for (const turn of turns) {
    if (!turn.actorKey || turn.latencyMode === 'precise') continue;
    const items = turnsByActor.get(turn.actorKey) ?? [];
    items.push(turn);
    turnsByActor.set(turn.actorKey, items);
  }

  for (const [actorKey, actorTurns] of turnsByActor.entries()) {
    actorTurns.sort((a, b) => a.startIso.localeCompare(b.startIso));
    const events = actorEvents.get(actorKey) ?? [];
    let eventIdx = 0;

    for (let i = 0; i < actorTurns.length; i++) {
      const turn = actorTurns[i];
      const nextStartIso = actorTurns[i + 1]?.startIso;

      while (eventIdx < events.length && events[eventIdx].isoTime < turn.startIso) {
        eventIdx++;
      }

      const matched: ActorEvent[] = [];
      let scanIdx = eventIdx;
      while (scanIdx < events.length && (!nextStartIso || events[scanIdx].isoTime < nextStartIso)) {
        matched.push(events[scanIdx]);
        scanIdx++;
      }
      eventIdx = scanIdx;

      if (matched.length === 0) continue;

      turn.toolCalls = matched
        .filter(event => event.kind === 'tool_start' && event.toolName)
        .map(event => ({ name: event.toolName! }));
      turn.toolCount = turn.toolCalls.length;
      turn.failed = matched.some(event => event.level === 'ERROR' || event.kind === 'error');

      const lastEvent = matched[matched.length - 1];
      turn.endIso = lastEvent.isoTime;
      turn.latencyMs = diffMs(turn.startIso, lastEvent.isoTime);
      turn.latencyMode = turn.latencyMs !== undefined ? 'best_effort' : 'missing';
      if (turn.latencyMode === 'best_effort') {
        turn.latencySource = '同一用户最后一条相关思考/工具/错误日志';
      }
    }
  }
}

const CHANNEL_LABEL: Record<Channel, string> = {
  wework: '企微',
  feishu: '飞书',
  telegram: 'TG',
  cli: 'CLI',
};

function buildToolStats(turns: TurnRecord[], agentNameMap: Map<string, string>): {
  totalCalls: number;
  toolSessions: number;
  toolMap: Map<string, ToolAggregate>;
  groupRows: Array<{ label: string; sessions: number; calls: number; avgCalls: number }>;
} {
  const toolMap = new Map<string, ToolAggregate>();
  const groupMap = new Map<string, { sessions: number; calls: number }>();
  let totalCalls = 0;
  let toolSessions = 0;

  for (const turn of turns) {
    if (turn.toolCount <= 0) continue;
    toolSessions++;
    totalCalls += turn.toolCount;

    const agentLabel = resolveAgentName(turn.agent, agentNameMap);
    const groupLabel = `${CHANNEL_LABEL[turn.channel]} / ${agentLabel}`;
    const group = groupMap.get(groupLabel) ?? { sessions: 0, calls: 0 };
    group.sessions += 1;
    group.calls += turn.toolCount;
    groupMap.set(groupLabel, group);

    const countedInSession = new Set<string>();
    for (const tool of turn.toolCalls) {
      const aggregate = toolMap.get(tool.name) ?? { calls: 0, sessions: 0, channels: new Map<Channel, number>() };
      aggregate.calls += 1;
      aggregate.channels.set(turn.channel, (aggregate.channels.get(turn.channel) ?? 0) + 1);
      if (!countedInSession.has(tool.name)) {
        aggregate.sessions += 1;
        countedInSession.add(tool.name);
      }
      toolMap.set(tool.name, aggregate);
    }

    const unnamedCalls = Math.max(turn.toolCount - turn.toolCalls.length, 0);
    if (unnamedCalls > 0) {
      const aggregate = toolMap.get('（未展开工具）') ?? { calls: 0, sessions: 0, channels: new Map<Channel, number>() };
      aggregate.calls += unnamedCalls;
      aggregate.sessions += 1;
      aggregate.channels.set(turn.channel, (aggregate.channels.get(turn.channel) ?? 0) + unnamedCalls);
      toolMap.set('（未展开工具）', aggregate);
    }
  }

  const groupRows = [...groupMap.entries()]
    .map(([label, item]) => ({
      label,
      sessions: item.sessions,
      calls: item.calls,
      avgCalls: Number((item.calls / item.sessions).toFixed(2)),
    }))
    .sort((a, b) => b.calls - a.calls || b.sessions - a.sessions);

  return { totalCalls, toolSessions, toolMap, groupRows };
}

function summarizeLatency(turns: TurnRecord[]): {
  analyzed: TurnRecord[];
  preciseCount: number;
  bestEffortCount: number;
  missingCount: number;
  failedCount: number;
} {
  const analyzed = turns.filter(turn => turn.latencyMs !== undefined);
  return {
    analyzed,
    preciseCount: turns.filter(turn => turn.latencyMode === 'precise').length,
    bestEffortCount: turns.filter(turn => turn.latencyMode === 'best_effort').length,
    missingCount: turns.filter(turn => turn.latencyMode === 'missing').length,
    failedCount: turns.filter(turn => turn.failed).length,
  };
}

function buildLatencyMetricRow(label: string, turns: TurnRecord[], modeLabel?: string): string | null {
  const values = turns.map(turn => turn.latencyMs).filter((value): value is number => value !== undefined);
  if (values.length === 0) return null;
  const mode = modeLabel ?? (turns.every(turn => turn.latencyMode === 'precise') ? '精确' : turns.every(turn => turn.latencyMode === 'best_effort') ? '近似' : '混合');
  const p90 = formatMs(percentile(values, 0.9));
  const p95 = formatMs(percentile(values, 0.95));
  const pDisplay = reportSource === 'telemetry' ? `${p90} / ${p95}` : p90;
  return `| ${label} | ${values.length} | ${mode} | ${formatMs(average(values))} | ${formatMs(percentile(values, 0.5))} | ${pDisplay} | ${formatMs(Math.max(...values))} | ${formatMs(Math.min(...values))} |`;
}

function formatTurnToolSummary(turn: TurnRecord): string {
  if (turn.toolCount <= 0) return '—';

  const grouped = new Map<string, { count: number; durations: number[] }>();
  for (const tool of turn.toolCalls) {
    const item = grouped.get(tool.name) ?? { count: 0, durations: [] };
    item.count += 1;
    if (tool.durationMs !== undefined) item.durations.push(tool.durationMs);
    grouped.set(tool.name, item);
  }

  const parts = [...grouped.entries()].map(([name, item]) => {
    const countLabel = item.count > 1 ? ` x${item.count}` : '';
    const durationTotal = item.durations.length > 0
      ? item.durations.reduce((sum, cur) => sum + cur, 0)
      : undefined;
    const durationLabel = durationTotal !== undefined ? ` (${formatMs(durationTotal)})` : '';
    return `${name}${countLabel}${durationLabel}`;
  });

  const unnamedCalls = Math.max(turn.toolCount - turn.toolCalls.length, 0);
  if (unnamedCalls > 0) {
    parts.push(`（未展开工具） x${unnamedCalls}`);
  }
  return sanitizeTableCell(truncate(parts.join('；'), 120));
}

function formatTurnLatency(turn: TurnRecord): string {
  if (turn.latencyMs === undefined) return '—';
  const modeLabel = turn.latencyMode === 'precise' ? '精确' : turn.latencyMode === 'best_effort' ? '近似' : '缺失';
  return `${formatMs(turn.latencyMs)} (${modeLabel})`;
}

function formatToken(n?: number): string {
  if (n === undefined) return '—';
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

function buildTelemetrySections(turns: TurnRecord[]): string[] {
  const lines: string[] = [];

  // --- Token 用量 ---
  const withTokens = turns.filter(t => t.inputTokens !== undefined && t.outputTokens !== undefined);
  if (withTokens.length > 0) {
    lines.push('### Token 用量');
    lines.push('');
    const inputVals = withTokens.map(t => t.inputTokens!);
    const outputVals = withTokens.map(t => t.outputTokens!);
    const totalInput = inputVals.reduce((a, b) => a + b, 0);
    const totalOutput = outputVals.reduce((a, b) => a + b, 0);

    lines.push(`- 会话数: ${withTokens.length}`);
    lines.push(`- 总输入 token: ${formatToken(totalInput)}`);
    lines.push(`- 总输出 token: ${formatToken(totalOutput)}`);
    lines.push(`- 输入 P50 / P95 / P99: ${formatToken(percentile(inputVals, 0.5))} / ${formatToken(percentile(inputVals, 0.95))} / ${formatToken(percentile(inputVals, 0.99))}`);
    lines.push(`- 输出 P50 / P95 / P99: ${formatToken(percentile(outputVals, 0.5))} / ${formatToken(percentile(outputVals, 0.95))} / ${formatToken(percentile(outputVals, 0.99))}`);
    lines.push(`- 平均每会话输入: ${formatToken(average(inputVals))} / 输出: ${formatToken(average(outputVals))}`);

    // Per-model breakdown
    const modelMap = new Map<string, { count: number; inputTokens: number[]; outputTokens: number[] }>();
    for (const t of withTokens) {
      const mdl = t.model || 'unknown';
      const entry = modelMap.get(mdl) ?? { count: 0, inputTokens: [], outputTokens: [] };
      entry.count++;
      entry.inputTokens.push(t.inputTokens!);
      entry.outputTokens.push(t.outputTokens!);
      modelMap.set(mdl, entry);
    }
    if (modelMap.size > 0) {
      lines.push('');
      lines.push('| Model | 会话数 | 平均输入 | 平均输出 | P95 输入 | P95 输出 |');
      lines.push('|-------|--------|---------|---------|----------|---------|');
      for (const [mdl, entry] of [...modelMap.entries()].sort((a, b) => b[1].count - a[1].count)) {
        lines.push(`| ${mdl} | ${entry.count} | ${formatToken(average(entry.inputTokens))} | ${formatToken(average(entry.outputTokens))} | ${formatToken(percentile(entry.inputTokens, 0.95))} | ${formatToken(percentile(entry.outputTokens, 0.95))} |`);
      }
    }
    lines.push('');
  }

  // --- 分段耗时 ---
  const withSegments = turns.filter(t => t.ctxMs !== undefined);
  if (withSegments.length > 0) {
    lines.push('### 分段耗时拆解');
    lines.push('');
    const avgCtx = average(withSegments.map(t => t.ctxMs!)) ?? 0;
    const avgLlm = average(withSegments.map(t => t.llmTotalMs!)) ?? 0;
    const avgTool = average(withSegments.map(t => t.toolTotalMs!)) ?? 0;
    const avgRender = average(withSegments.map(t => t.renderMs!)) ?? 0;
    const avgTotal = avgCtx + avgLlm + avgTool + avgRender;

    const pct = (v: number) => avgTotal > 0 ? `${((v / avgTotal) * 100).toFixed(0)}%` : '—';

    lines.push(`| 阶段 | 平均耗时 | 占比 | P50 | P95 |`);
    lines.push(`|------|---------|------|-----|-----|`);
    lines.push(`| ctx (上下文准备) | ${formatMs(avgCtx)} | ${pct(avgCtx)} | ${formatMs(percentile(withSegments.map(t => t.ctxMs!), 0.5))} | ${formatMs(percentile(withSegments.map(t => t.ctxMs!), 0.95))} |`);
    lines.push(`| LLM 调用 | ${formatMs(avgLlm)} | ${pct(avgLlm)} | ${formatMs(percentile(withSegments.map(t => t.llmTotalMs!), 0.5))} | ${formatMs(percentile(withSegments.map(t => t.llmTotalMs!), 0.95))} |`);
    lines.push(`| 工具执行 | ${formatMs(avgTool)} | ${pct(avgTool)} | ${formatMs(percentile(withSegments.map(t => t.toolTotalMs!), 0.5))} | ${formatMs(percentile(withSegments.map(t => t.toolTotalMs!), 0.95))} |`);
    lines.push(`| render | ${formatMs(avgRender)} | ${pct(avgRender)} | ${formatMs(percentile(withSegments.map(t => t.renderMs!), 0.5))} | ${formatMs(percentile(withSegments.map(t => t.renderMs!), 0.95))} |`);
    lines.push(`| **合计** | **${formatMs(avgTotal)}** | — | — | — |`);
    lines.push('');
  }

  // --- 知识库命中率 ---
  const withKnowledge = turns.filter(t => t.knowledgeHitsTotal !== undefined);
  if (withKnowledge.length > 0) {
    const totalSearches = withKnowledge.reduce((s, t) => s + (t.knowledgeHitsTotal ?? 0), 0);
    const searchedSessions = withKnowledge.filter(t => (t.knowledgeHitsTotal ?? 0) > 0).length;
    const zeroHitSessions = withKnowledge.filter(t => t.knowledgeZeroHitCount !== undefined && t.knowledgeZeroHitCount > 0).length;

    lines.push('### 知识库命中');
    lines.push('');
    lines.push(`- 搜索过的会话: ${searchedSessions} / ${withKnowledge.length}`);
    lines.push(`- 总命中数: ${totalSearches}`);
    lines.push(`- 至少一次零命中的会话: ${zeroHitSessions} (${searchedSessions > 0 ? ((zeroHitSessions / searchedSessions) * 100).toFixed(1) : 0}%)`);

    const allHits = withKnowledge.map(t => t.knowledgeHitsTotal ?? 0);
    lines.push(`- 每会话命中 P50 / P95: ${percentile(allHits, 0.5)?.toFixed(0)} / ${percentile(allHits, 0.95)?.toFixed(0)}`);
    lines.push('');
  }

  // --- 工具成功率 ---
  const withToolStats = turns.filter(t => t.toolSuccessCount !== undefined);
  if (withToolStats.length > 0) {
    const totalSuccess = withToolStats.reduce((s, t) => s + (t.toolSuccessCount ?? 0), 0);
    const totalFail = withToolStats.reduce((s, t) => s + (t.toolFailCount ?? 0), 0);
    const totalTools = totalSuccess + totalFail;
    const failRate = totalTools > 0 ? ((totalFail / totalTools) * 100).toFixed(1) : '0';

    lines.push('### 工具调用成功率');
    lines.push('');
    lines.push(`- 成功: ${totalSuccess} / 失败: ${totalFail} / 总计: ${totalTools}`);
    lines.push(`- 失败率: ${failRate}%`);
    lines.push('');
  }

  return lines;
}

function buildMarkdown(turns: TurnRecord[], dateLabel: string, agentNameMap: Map<string, string>): string {
  const lines: string[] = [];
  const isTelemetry = reportSource === 'telemetry';

  lines.push(`# Samata 使用报告 — ${dateLabel}`);
  lines.push('');
  lines.push(`## 用户提问记录 (共 ${turns.length} 条)`);
  lines.push('');

  // Use different column headers based on data source
  const contentColHeader = isTelemetry ? '回复摘要' : '问题';
  lines.push(`| # | 时间 | 用户 | 渠道 | Agent | 聊天 | ${contentColHeader} | 工具调用 | 耗时 |`);
  lines.push('|---|------|------|------|-------|------|------|----------|------|');

  turns.forEach((turn, i) => {
    const content = sanitizeTableCell(truncate(turn.content.replace(/\n/g, ' '), 80));
    const ch = CHANNEL_LABEL[turn.channel];
    const agent = sanitizeTableCell(resolveAgentName(turn.agent, agentNameMap));
    const toolSummary = formatTurnToolSummary(turn);
    const latency = sanitizeTableCell(formatTurnLatency(turn));
    lines.push(`| ${i + 1} | ${turn.time} | ${turn.userid} | ${ch} | ${agent} | ${turn.chattype} | ${content} | ${toolSummary} | ${latency} |`);
  });

  const userCount = new Map<string, number>();
  const typeCount = new Map<string, number>();
  const channelCount = new Map<string, number>();
  const agentCount = new Map<string, number>();

  for (const turn of turns) {
    userCount.set(turn.userid, (userCount.get(turn.userid) ?? 0) + 1);
    typeCount.set(turn.msgtype, (typeCount.get(turn.msgtype) ?? 0) + 1);
    const ch = CHANNEL_LABEL[turn.channel];
    channelCount.set(ch, (channelCount.get(ch) ?? 0) + 1);
    const agentLabel = resolveAgentName(turn.agent, agentNameMap);
    if (agentLabel) agentCount.set(agentLabel, (agentCount.get(agentLabel) ?? 0) + 1);
  }

  lines.push('');
  lines.push('## 统计');
  lines.push('');
  lines.push(`- 总提问数: ${turns.length}`);
  lines.push(`- 活跃用户: ${userCount.size} 人`);

  lines.push('');
  lines.push('### 渠道分布');
  lines.push('');
  lines.push('| 渠道 | 提问数 |');
  lines.push('|------|--------|');
  for (const [ch, count] of [...channelCount.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${ch} | ${count} |`);
  }

  if (agentCount.size > 0) {
    lines.push('');
    lines.push('### Agent 分布');
    lines.push('');
    lines.push('| Agent | 提问数 |');
    lines.push('|-------|--------|');
    for (const [agent, count] of [...agentCount.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${agent} | ${count} |`);
    }
  }

  lines.push('');
  lines.push('### 用户排行');
  lines.push('');
  lines.push('| 用户 | 提问数 |');
  lines.push('|------|--------|');
  for (const [user, count] of [...userCount.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${user} | ${count} |`);
  }

  if (typeCount.size > 1) {
    lines.push('');
    lines.push('### 消息类型');
    lines.push('');
    lines.push('| 消息类型 | 数量 |');
    lines.push('|----------|------|');
    for (const [type, count] of [...typeCount.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${type} | ${count} |`);
    }
  }

  const toolStats = buildToolStats(turns, agentNameMap);
  lines.push('');
  lines.push('### Agent 工具调用情况');
  lines.push('');
  lines.push(`- 纳入统计会话: ${turns.length}`);
  lines.push(`- 发生工具调用的会话: ${toolStats.toolSessions}`);
  lines.push(`- 总工具调用次数: ${toolStats.totalCalls}`);
  lines.push(`- 涉及工具数: ${toolStats.toolMap.size}`);

  if (toolStats.toolMap.size > 0) {
    lines.push('');
    lines.push('| 工具 | 调用次数 | 覆盖会话 | 主要渠道 |');
    lines.push('|------|----------|----------|----------|');
    for (const [tool, stat] of [...toolStats.toolMap.entries()].sort((a, b) => b[1].calls - a[1].calls || b[1].sessions - a[1].sessions).slice(0, 12)) {
      const channelSummary = [...stat.channels.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([channel, count]) => `${CHANNEL_LABEL[channel]} ${count}`)
        .join(' / ');
      lines.push(`| ${tool} | ${stat.calls} | ${stat.sessions} | ${channelSummary || '—'} |`);
    }

    lines.push('');
    lines.push('| 渠道 / Agent | 会话数 | 工具调用数 | 平均每会话 |');
    lines.push('|--------------|--------|------------|------------|');
    for (const row of toolStats.groupRows.slice(0, 12)) {
      lines.push(`| ${row.label} | ${row.sessions} | ${row.calls} | ${row.avgCalls.toFixed(2)} |`);
    }
  }

  const latencySummary = summarizeLatency(turns);
  lines.push('');
  lines.push('### 延时分析');
  lines.push('');
  lines.push(`- 纳入分析会话: ${latencySummary.analyzed.length}`);
  lines.push(`- 精确统计: ${latencySummary.preciseCount}`);
  lines.push(`- 近似统计: ${latencySummary.bestEffortCount}`);
  lines.push(`- 缺失: ${latencySummary.missingCount}`);
  lines.push(`- 失败会话: ${latencySummary.failedCount}`);

  if (latencySummary.analyzed.length > 0) {
    lines.push('');
    const rangeHeader = reportSource === 'telemetry' ? 'P90 / P95' : 'P90';
    lines.push(`| 范围 | 会话数 | 口径 | 平均 | 中位数 | ${rangeHeader} | 最慢 | 最快 |`);
    lines.push(`|------|--------|------|------|--------|${rangeHeader === 'P90' ? '-----' : '----------'}|------|------|`);
    const overallRow = buildLatencyMetricRow('总体', latencySummary.analyzed);
    if (overallRow) lines.push(overallRow);
    const preciseRow = buildLatencyMetricRow('仅精确值', turns.filter(turn => turn.latencyMode === 'precise'), '精确');
    if (preciseRow) lines.push(preciseRow);
    const bestEffortRow = buildLatencyMetricRow('仅近似值', turns.filter(turn => turn.latencyMode === 'best_effort'), '近似');
    if (bestEffortRow) lines.push(bestEffortRow);

    lines.push('');
    lines.push(`| 渠道 | 会话数 | 口径 | 平均 | 中位数 | ${rangeHeader} | 最慢 | 最快 |`);
    lines.push(`|------|--------|------|------|--------|${rangeHeader === 'P90' ? '-----' : '----------'}|------|------|`);
    for (const channel of ['wework', 'feishu', 'telegram', 'cli'] as Channel[]) {
      const row = buildLatencyMetricRow(CHANNEL_LABEL[channel], turns.filter(turn => turn.channel === channel && turn.latencyMs !== undefined));
      if (row) lines.push(row);
    }
  }

  // Anomaly monitoring (errors, no-reply, tool exhaustion, dead loops)
  lines.push(...buildAnomalyReport(turns, agentNameMap));

  // Telemetry-only sections
  if (reportSource === 'telemetry') {
    lines.push(...buildTelemetrySections(turns));
  }

  lines.push('');
  lines.push('### 口径说明');
  lines.push('');
  lines.push('- 飞书延时为精确值，直接取 `AI 对话完成` block 中的 `elapsed=...ms`。');
  lines.push('- 企微与 TG 延时为 best-effort，按同一用户后续相关思考/工具/错误日志的最后时间点近似估算。');
  lines.push('- best-effort 延时不等同于客户端真正收包时间，更适合做趋势观察，不适合做严格 SLA。');
  lines.push('- 工具调用排行优先统计可识别工具名；若飞书完成 block 只展开前 8 个工具，其余调用记为 `（未展开工具）`。');

  if (reportSource === 'telemetry') {
    lines.push('- **数据来源**: telemetry JSONL，延时为 ctx + llm + tool + render 四段精确合计。');
    lines.push('- token 用量来自各 provider SDK 原始返回，不同模型的 tokenizer 口径不完全可比。');
    lines.push('- 知识库命中统计：仅计入 search_knowledge 工具调用，不包含文档 grep 搜索。');
    lines.push('- **注意**: telemetry 数据不含用户原始提问内容，表中"回复摘要"列为 AI 回答的前 500 字符摘要。');
  }

  lines.push('');
  return lines.join('\n');
}

function buildCSV(turns: TurnRecord[], agentNameMap: Map<string, string>): string {
  const isTelemetry = reportSource === 'telemetry';
  const baseHeaders = ['序号', '时间', '用户', '渠道', 'Agent', '聊天类型', '消息类型', '问题', '工具数', '耗时ms'];
  const telemetryHeaders = ['输入token', '输出token', 'ctx_ms', 'llm_ms', 'tool_ms', 'render_ms', 'loop轮次', 'stop_reason', 'knowledge命中', '工具成功', '工具失败'];
  const headers = isTelemetry ? [...baseHeaders, ...telemetryHeaders] : baseHeaders;
  const lines: string[] = [headers.join(',')];

  turns.forEach((turn, i) => {
    const content = turn.content.replace(/"/g, '""').replace(/\n/g, ' ');
    const ch = CHANNEL_LABEL[turn.channel];
    const agent = resolveAgentName(turn.agent, agentNameMap);
    const baseFields = [
      i + 1, `"${turn.time}"`, `"${turn.userid}"`, `"${ch}"`, `"${agent}"`,
      `"${turn.chattype}"`, `"${turn.msgtype}"`, `"${content}"`,
      turn.toolCount, turn.latencyMs ?? '',
    ];
    if (isTelemetry) {
      baseFields.push(
        turn.inputTokens ?? '', turn.outputTokens ?? '',
        turn.ctxMs ?? '', turn.llmTotalMs ?? '', turn.toolTotalMs ?? '', turn.renderMs ?? '',
        turn.loopRounds ?? '', turn.stopReason ?? '',
        turn.knowledgeHitsTotal ?? '',
        turn.toolSuccessCount ?? '', turn.toolFailCount ?? '',
      );
    }
    lines.push(baseFields.join(','));
  });
  return lines.join('\n') + '\n';
}

async function writeToPostgres(
  turns: TurnRecord[],
  dates: string[],
  source: DataSource,
  agentNameMap: Map<string, string>,
): Promise<void> {
  const configPath = join(process.cwd(), '..', 'dataSync', 'config', 'config.json');
  if (!existsSync(configPath)) {
    console.warn('[pg] DataSync config.json 不存在，跳过 PostgreSQL 写入');
    return;
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const pgHost = config.PG_HOST || '10.8.0.1';
  const pgPort = config.PG_PORT || 5432;
  const pgUser = config.PG_USER || 'wind_sync';
  const pgPass = config.PG_PASS || 'wind_sync';
  const pgDb = config.PG_DATABASE || 'wind_sync';

  // Dynamic require via createRequire for ESM compat
  const { Client } = nodeRequire('pg');
  const client = new Client({
    host: pgHost,
    port: pgPort,
    user: pgUser,
    password: pgPass,
    database: pgDb,
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();

    // Create table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS samata_user_questions (
        id SERIAL PRIMARY KEY,
        time TIMESTAMPTZ NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        agent_name TEXT,
        chat_type TEXT,
        user_question TEXT,
        answer_preview TEXT,
        tool_calls TEXT,
        tool_count INTEGER,
        latency_ms INTEGER,
        source TEXT,
        report_date DATE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create unique index (ignore error if already exists)
    try {
      await client.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_question_unique ON samata_user_questions (report_date, time, user_id)',
      );
    } catch {
      // index may already exist
    }

    // Prepare report_date from dates array
    const reportDate = dates[0] || new Date().toISOString().slice(0, 10);
    const isTelemetry = source === 'telemetry';

    // Upsert each turn
    let inserted = 0;
    for (const turn of turns) {
      const agentName = resolveAgentName(turn.agent, agentNameMap);
      const userQuestion = isTelemetry ? null : turn.content;
      const answerPreview = isTelemetry ? turn.content : null;
      const toolCallsJson = turn.toolCalls.length > 0 ? JSON.stringify(turn.toolCalls) : null;

      try {
        await client.query(
          `INSERT INTO samata_user_questions
             (time, user_id, channel, agent_name, chat_type,
              user_question, answer_preview, tool_calls, tool_count,
              latency_ms, source, report_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (report_date, time, user_id)
           DO UPDATE SET
             agent_name = EXCLUDED.agent_name,
             user_question = COALESCE(EXCLUDED.user_question, samata_user_questions.user_question),
             answer_preview = COALESCE(EXCLUDED.answer_preview, samata_user_questions.answer_preview),
             tool_calls = EXCLUDED.tool_calls,
             tool_count = EXCLUDED.tool_count,
             latency_ms = EXCLUDED.latency_ms,
             source = EXCLUDED.source`,
          [
            turn.startIso,         // ISO 8601 timestamp
            turn.userid,
            turn.channel,
            agentName,
            turn.chattype,
            userQuestion,
            answerPreview,
            toolCallsJson,
            turn.toolCount,
            turn.latencyMs ?? null,
            source,
            reportDate,
          ],
        );
        inserted++;
      } catch (rowErr: any) {
        console.warn(`[pg] 写入失败: ${turn.time} ${turn.userid} — ${rowErr?.message ?? String(rowErr)}`);
      }
    }

    console.warn(`[pg] 已写入 PostgreSQL: ${inserted}/${turns.length} 条 (${pgHost}:${pgPort}/${pgDb}, table=samata_user_questions)`);
  } catch (err: any) {
    console.warn(`[pg] PostgreSQL 连接失败: ${err?.message ?? String(err)}`);
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

function extractDateFromPath(logPath: string): string {
  const m = basename(logPath).match(/(?:app|telemetry)-(\d{4}-\d{2}-\d{2})\.(?:log|jsonl)/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

function loadAgentNameMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const dbPath = join(process.cwd(), 'data', 'yanyu.db');
    if (!existsSync(dbPath)) return map;
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT id, name, display_name FROM agents').all() as { id: string; name: string; display_name: string }[];
    for (const row of rows) {
      // Map by DB id (UUID)
      map.set(row.id, row.display_name || row.name);
      // Map by name (e.g., 'otcclaw' → '衍语')
      map.set(row.name, row.display_name || row.name);
      // Map by 'agent-<name>' format used in older telemetry records
      map.set(`agent-${row.name}`, row.display_name || row.name);
    }
    db.close();
  } catch {
    // DB not accessible — agent names will display as-is
  }
  return map;
}

function resolveAgentName(agentId: string, nameMap: Map<string, string>): string {
  if (!agentId) return '—';
  return nameMap.get(agentId) || agentId;
}

function buildAnomalyReport(turns: TurnRecord[], agentNameMap: Map<string, string>): string[] {
  const lines: string[] = [];
  const isTelemetry = reportSource === 'telemetry';

  lines.push('### 异常监控');
  lines.push('');

  // 1. Error / failed turns
  const failedTurns = turns.filter(t => t.failed || t.stopReason === 'error');
  if (failedTurns.length > 0) {
    lines.push(`- **报错会话**: ${failedTurns.length} 条`);
    for (const t of failedTurns) {
      const ch = CHANNEL_LABEL[t.channel];
      const agent = resolveAgentName(t.agent, agentNameMap);
      const reason = t.stopReason || (t.failed ? 'error' : '—');
      lines.push(`  - ${t.time} | ${ch} | ${agent} | ${t.userid} | reason=${reason} | ${sanitizeTableCell(truncate(t.content.replace(/\n/g, ' '), 60))}`);
    }
    lines.push('');
  }

  // 2. No reply (empty answer)
  const noReplyTurns = turns.filter(t => {
    if (isTelemetry) return !t.content || t.content === '(无文本回复)';
    return t.failed && t.toolCount === 0;
  });
  if (noReplyTurns.length > 0) {
    lines.push(`- **无回复会话**: ${noReplyTurns.length} 条`);
    for (const t of noReplyTurns) {
      const ch = CHANNEL_LABEL[t.channel];
      const agent = resolveAgentName(t.agent, agentNameMap);
      const rounds = t.loopRounds !== undefined ? ` rounds=${t.loopRounds}` : '';
      lines.push(`  - ${t.time} | ${ch} | ${agent} | ${t.userid}${rounds} | ${sanitizeTableCell(truncate(t.content !== '(无文本回复)' ? t.content.replace(/\n/g, ' ') : '(空)', 60))}`);
    }
    lines.push('');
  }

  // 3. Tool budget exhaustion (reached max rounds without completing)
  if (isTelemetry) {
    const MAX_ROUNDS = 12;
    const exhaustedTurns = turns.filter(t => t.loopRounds !== undefined && t.loopRounds >= MAX_ROUNDS);
    if (exhaustedTurns.length > 0) {
      lines.push(`- **工具调用达上限** (>=${MAX_ROUNDS}轮): ${exhaustedTurns.length} 条`);
      for (const t of exhaustedTurns) {
        const ch = CHANNEL_LABEL[t.channel];
        const agent = resolveAgentName(t.agent, agentNameMap);
        const tools = t.toolCount;
        lines.push(`  - ${t.time} | ${ch} | ${agent} | ${t.userid} | rounds=${t.loopRounds} tools=${tools} | ${sanitizeTableCell(truncate(t.content.replace(/\n/g, ' '), 60))}`);
      }
      lines.push('');
    }
  } else {
    // App log: treat high tool count as potential exhaustion
    const HIGH_TOOL_THRESHOLD = 20;
    const heavyTurns = turns.filter(t => t.toolCount >= HIGH_TOOL_THRESHOLD);
    if (heavyTurns.length > 0) {
      lines.push(`- **疑似工具调用过载** (>=${HIGH_TOOL_THRESHOLD}次): ${heavyTurns.length} 条`);
      for (const t of heavyTurns) {
        const ch = CHANNEL_LABEL[t.channel];
        const agent = resolveAgentName(t.agent, agentNameMap);
        lines.push(`  - ${t.time} | ${ch} | ${agent} | ${t.userid} | tools=${t.toolCount} | ${sanitizeTableCell(truncate(t.content.replace(/\n/g, ' '), 60))}`);
      }
      lines.push('');
    }
  }

  // 4. Dead loop detection (high rounds + no answer = likely stuck)
  if (isTelemetry) {
    const LOOP_THRESHOLD = 6;
    const deadLoops = turns.filter(t => {
      if (t.loopRounds === undefined) return false;
      const noAnswer = !t.content || t.content === '(无文本回复)';
      return t.loopRounds >= LOOP_THRESHOLD && noAnswer;
    });
    if (deadLoops.length > 0) {
      lines.push(`- **疑似死循环** (>=${LOOP_THRESHOLD}轮 + 无回复): ${deadLoops.length} 条`);
      for (const t of deadLoops) {
        const ch = CHANNEL_LABEL[t.channel];
        const agent = resolveAgentName(t.agent, agentNameMap);
        const stopInfo = t.stopReason ? ` stop=${t.stopReason}` : '';
        lines.push(`  - ${t.time} | ${ch} | ${agent} | ${t.userid} | rounds=${t.loopRounds} tools=${t.toolCount}${stopInfo}`);
      }
      lines.push('');
    }
  }

  // Summary line when no anomalies found
  if (failedTurns.length === 0 && noReplyTurns.length === 0) {
    const exhaustedCount = isTelemetry
      ? turns.filter(t => t.loopRounds !== undefined && t.loopRounds >= 12).length
      : turns.filter(t => t.toolCount >= 20).length;
    if (exhaustedCount === 0) {
      const deadLoopCount = isTelemetry
        ? turns.filter(t => t.loopRounds !== undefined && t.loopRounds >= 6 && (!t.content || t.content === '(无文本回复)')).length
        : 0;
      if (deadLoopCount === 0) {
        lines.push('✅ 未检测到异常（报错、无回复、工具耗尽、死循环）。');
        lines.push('');
      }
    }
  }

  return lines;
}

const VALID_CHANNELS: Channel[] = ['wework', 'feishu', 'telegram', 'cli'];
let reportSource: DataSource = 'app'; // set in main, used by buildMarkdown

// --- main ---
const args = process.argv.slice(2);
const csvMode = args.includes('--csv');
const pgMode = args.includes('--pg');
const channelArg = parseArg(args, '--channel=') as Channel | undefined;
const sourceArg = (parseArg(args, '--source=') as DataSource) ?? 'auto';

if (channelArg && !VALID_CHANNELS.includes(channelArg)) {
  console.error(`无效渠道: ${channelArg}，可选: ${VALID_CHANNELS.join(', ')}`);
  process.exit(1);
}
if (sourceArg && !['auto', 'telemetry', 'app'].includes(sourceArg)) {
  console.error(`无效 source: ${sourceArg}，可选: auto, telemetry, app`);
  process.exit(1);
}

const { paths, source } = resolveLogPaths(args, sourceArg);
reportSource = source;

let turns: TurnRecord[];
if (source === 'telemetry') {
  turns = parseTelemetryTurns(paths);
} else {
  const allLines: string[] = [];
  for (const p of paths) {
    allLines.push(...readFileSync(p, 'utf8').split('\n'));
  }
  turns = parseAllTurns(allLines);
}

if (channelArg) {
  turns = turns.filter(turn => turn.channel === channelArg);
}

if (turns.length === 0) {
  const suffix = channelArg ? ` (渠道: ${channelArg})` : '';
  console.log(`未找到用户提问记录${suffix}。`);
  process.exit(0);
}

const dates = paths.map(extractDateFromPath);
const dateLabel = dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`;
const fileTag = dates.length === 1 ? dates[0] : `${dates[0]}_${dates[dates.length - 1]}`;

const agentNameMap = loadAgentNameMap();
if (agentNameMap.size > 0) {
  console.warn(`已加载 ${agentNameMap.size} 条 agent 名称映射`);
}

const srcSuffix = source === 'telemetry' ? ' [telemetry]' : '';
const channelSuffix = channelArg ? ` (渠道: ${CHANNEL_LABEL[channelArg]})` : '';
const output = csvMode
  ? buildCSV(turns, agentNameMap)
  : buildMarkdown(turns, dateLabel + srcSuffix + channelSuffix, agentNameMap);
console.log(output);

const outDir = join(process.cwd(), 'logs', 'daily_usage');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const ext = csvMode ? 'csv' : 'md';
const srcFileTag = source === 'telemetry' ? '_telemetry' : '';
const channelFileTag = channelArg ? `_${channelArg}` : '';
const outFile = join(outDir, `${fileTag}${srcFileTag}${channelFileTag}.${ext}`);
writeFileSync(outFile, output, 'utf8');
console.log(`\n=> 已写入 ${outFile}`);

// PostgreSQL 写入（--pg 模式）
if (pgMode) {
  void writeToPostgres(turns, dates, source, agentNameMap).then(() => {
    process.exit(0);
  });
}
