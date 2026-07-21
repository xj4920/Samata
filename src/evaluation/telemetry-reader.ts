import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { basename } from 'path';
import type { ScenarioTaxonomy, TelemetryScenarioCandidate } from './types.js';
import { hashTelemetryIdentifier, redactText, redactValue, type RedactionOptions } from './redaction.js';

interface RawTelemetryToolCall {
  name?: unknown;
  round?: unknown;
  duration_ms?: unknown;
  success?: unknown;
  input?: unknown;
  output_preview?: unknown;
  error?: unknown;
}

interface RawTelemetryTurn {
  turn_id?: unknown;
  agent_id?: unknown;
  channel?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  ctx_ms?: unknown;
  llm_total_ms?: unknown;
  tool_total_ms?: unknown;
  render_ms?: unknown;
  loop_rounds?: unknown;
  total_tool_calls?: unknown;
  stop_reason?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  user_question?: unknown;
  answer_preview?: unknown;
  tools?: unknown;
}

export interface TelemetryReadFilters {
  from?: string;
  to?: string;
  agent?: string;
  channel?: string;
  minToolCalls?: number;
  includeEmptyQuestion?: boolean;
}

export interface TelemetryReadResult {
  totalTurns: number;
  eligibleTurns: number;
  malformedLines: number;
  candidates: TelemetryScenarioCandidate[];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeQuestion(input: string): string {
  return input
    .toLowerCase()
    .replace(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, '<date>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, '')
    .slice(0, 500);
}

function redactSerialized(input: string, options: RedactionOptions): string {
  try {
    return JSON.stringify(redactValue(JSON.parse(input), options));
  } catch {
    return redactText(input, options);
  }
}

function toolCategory(name: string): string {
  if (/knowledge|wiki|document|doc_search|read_page/i.test(name)) return 'knowledge';
  if (/web|browser|devtools|wechat|url|http|search_engine/i.test(name)) return 'web';
  if (/file|markdown|artifact|media|image|pdf|excel|csv|archive|export/i.test(name)) return 'artifact';
  if (/reminder|todo|schedule|deliver|send|notify/i.test(name)) return 'delivery';
  if (/agent|skill|memory|sandbox|system|shell|process/i.test(name)) return 'system';
  if (/date|time|calendar/i.test(name)) return 'date';
  return 'business';
}

function suggestedTags(turn: RawTelemetryTurn, toolFailures: number): string[] {
  const tags = new Set<string>();
  tags.add(toolFailures > 0 ? 'tool_failure' : 'happy_path');
  if (numberValue(turn.loop_rounds) > 3 || numberValue(turn.total_tool_calls) > 3) tags.add('multi_round');
  if (stringValue(turn.stop_reason) === 'error') tags.add('error_stop');
  if (numberValue(turn.input_tokens) > 20_000) tags.add('long_context');
  return [...tags];
}

function classifyScenario(
  question: string,
  toolNames: string[],
  taxonomy: ScenarioTaxonomy,
): string {
  if (toolNames.some(name => /^(?:titans_code_|mcp_logyi_)/i.test(name))) {
    return 'incident_investigation';
  }
  const categories = new Set(toolNames.map(toolCategory).filter(category => category !== 'date'));
  if (toolNames.length === 0) return 'direct_answer';
  if (categories.size > 1 || toolNames.length >= 5) return 'complex_workflow';

  const category = [...categories][0];
  const categoryScenario: Record<string, string> = {
    knowledge: 'knowledge_retrieval',
    web: 'web_research',
    artifact: 'document_artifact',
    delivery: 'task_delivery',
    system: 'system_operation',
    business: 'business_query',
  };
  if (category && categoryScenario[category]) return categoryScenario[category];

  const normalized = question.toLowerCase();
  let best: { id: string; score: number } | undefined;
  for (const scenario of taxonomy.scenarios) {
    const score = (scenario.keywords ?? []).filter(keyword => normalized.includes(keyword.toLowerCase())).length;
    if (!best || score > best.score) best = { id: scenario.id, score };
  }
  return best && best.score > 0 ? best.id : 'business_query';
}

function safeAgentLabel(value: unknown): string {
  const raw = stringValue(value);
  if (!raw) return 'unknown';
  if (/^agent-[a-z0-9][a-z0-9_-]*$/i.test(raw)) return raw.slice('agent-'.length);
  if (/^[a-z][a-z0-9_-]{1,63}$/i.test(raw)) return raw;
  return `agent-${hashTelemetryIdentifier(raw).slice(0, 12)}`;
}

function toIso(value: unknown): string {
  const numeric = numberValue(value);
  if (!numeric) return '';
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function inDateRange(iso: string, filters: TelemetryReadFilters): boolean {
  if (!iso) return !filters.from && !filters.to;
  const date = iso.slice(0, 10);
  if (filters.from && date < filters.from) return false;
  if (filters.to && date > filters.to) return false;
  return true;
}

function candidateFromTurn(
  turn: RawTelemetryTurn,
  taxonomy: ScenarioTaxonomy,
  redaction: RedactionOptions,
): TelemetryScenarioCandidate {
  const rawTools = Array.isArray(turn.tools) ? turn.tools as RawTelemetryToolCall[] : [];
  const tools = rawTools.map(tool => ({
    name: stringValue(tool.name) || 'unknown_tool',
    round: numberValue(tool.round),
    success: tool.success === true,
    input: stringValue(tool.input) ? redactSerialized(stringValue(tool.input), redaction) : undefined,
    outputPreview: stringValue(tool.output_preview)
      ? redactSerialized(stringValue(tool.output_preview), redaction)
      : undefined,
    error: stringValue(tool.error) ? redactText(stringValue(tool.error), redaction) : undefined,
  }));
  const question = redactText(stringValue(turn.user_question), redaction);
  const answerPreview = redactText(stringValue(turn.answer_preview), redaction);
  const observedAt = toIso(turn.started_at);
  const turnId = stringValue(turn.turn_id) || `${observedAt}:${question}`;
  const turnHash = hashTelemetryIdentifier(turnId);
  const toolFailures = tools.filter(tool => !tool.success).length;
  const totalDuration = ['ctx_ms', 'llm_total_ms', 'tool_total_ms', 'render_ms']
    .reduce((sum, key) => sum + numberValue(turn[key as keyof RawTelemetryTurn]), 0);
  const fingerprintSource = `${normalizeQuestion(question)}|${tools.map(tool => tool.name).join('>')}|${toolFailures > 0 ? 'failure' : 'success'}`;
  const fingerprint = createHash('sha256').update(fingerprintSource).digest('hex').slice(0, 20);
  const scenario = classifyScenario(question, tools.map(tool => tool.name), taxonomy);
  const tags = suggestedTags(turn, toolFailures);
  const priorityScore = 10
    + Math.min(20, tools.length * 2)
    + Math.min(20, numberValue(turn.loop_rounds) * 2)
    + toolFailures * 12
    + (stringValue(turn.stop_reason) === 'error' ? 20 : 0);

  return {
    candidateId: `candidate-${turnHash}`,
    turnHash,
    observedAt,
    agent: safeAgentLabel(turn.agent_id),
    channel: stringValue(turn.channel) || 'unknown',
    question,
    answerPreview,
    telemetryIncomplete: true,
    scenario,
    suggestedTags: tags,
    fingerprint,
    clusterSize: 1,
    priorityScore,
    toolCalls: tools,
    metrics: {
      loopRounds: numberValue(turn.loop_rounds),
      totalToolCalls: numberValue(turn.total_tool_calls) || tools.length,
      toolFailures,
      inputTokens: numberValue(turn.input_tokens),
      outputTokens: numberValue(turn.output_tokens),
      durationMs: totalDuration,
      stopReason: stringValue(turn.stop_reason),
    },
  };
}

function eligible(turn: RawTelemetryTurn, filters: TelemetryReadFilters): boolean {
  const observedAt = toIso(turn.started_at);
  if (!inDateRange(observedAt, filters)) return false;
  if (filters.agent && stringValue(turn.agent_id) !== filters.agent) return false;
  if (filters.channel && stringValue(turn.channel) !== filters.channel) return false;
  if (numberValue(turn.total_tool_calls) < (filters.minToolCalls ?? 0)) return false;
  if (!filters.includeEmptyQuestion && !stringValue(turn.user_question).trim()) return false;
  return true;
}

export function readTelemetryCandidates(
  filePaths: string[],
  taxonomy: ScenarioTaxonomy,
  filters: TelemetryReadFilters = {},
  redaction: RedactionOptions = {},
): TelemetryReadResult {
  let totalTurns = 0;
  let eligibleTurns = 0;
  let malformedLines = 0;
  const rawCandidates: TelemetryScenarioCandidate[] = [];

  for (const filePath of filePaths) {
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let turn: RawTelemetryTurn;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object');
        turn = parsed as RawTelemetryTurn;
      } catch {
        malformedLines++;
        continue;
      }
      totalTurns++;
      if (!eligible(turn, filters)) continue;
      eligibleTurns++;
      rawCandidates.push(candidateFromTurn(turn, taxonomy, redaction));
    }
  }

  const clusters = new Map<string, TelemetryScenarioCandidate[]>();
  for (const candidate of rawCandidates) {
    const cluster = clusters.get(candidate.fingerprint) ?? [];
    cluster.push(candidate);
    clusters.set(candidate.fingerprint, cluster);
  }

  const candidates = [...clusters.values()].map(cluster => {
    const representative = [...cluster].sort((left, right) => right.priorityScore - left.priorityScore)[0];
    return {
      ...representative,
      clusterSize: cluster.length,
      priorityScore: representative.priorityScore + Math.min(30, (cluster.length - 1) * 3),
    };
  }).sort((left, right) => right.priorityScore - left.priorityScore || left.candidateId.localeCompare(right.candidateId));

  return { totalTurns, eligibleTurns, malformedLines, candidates };
}

export function telemetrySourceLabel(filePath: string): string {
  return basename(filePath);
}
