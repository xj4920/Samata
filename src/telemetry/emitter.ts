import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db/connection.js';
import { getExecutionContext } from '../runtime/execution-context.js';
import type {
  TelemetryTurn,
  TelemetryToolCall,
  TelemetryLLMCall,
  TelemetryKnowledgeHit,
} from './types.js';

const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const AUDIT_CONTENT_MAX_CHARS = 100_000;

function captureAuditContent(text: string): {
  content: string;
  chars: number;
  truncated: boolean;
} {
  return {
    content: text.slice(0, AUDIT_CONTENT_MAX_CHARS),
    chars: text.length,
    truncated: text.length > AUDIT_CONTENT_MAX_CHARS,
  };
}

function jsonlPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `telemetry-${today}.jsonl`);
}

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/** In-progress turn, keyed by session_id */
const activeTurns = new Map<string, TelemetryTurn>();

export function startTurn(sessionId: string, agentId: string, userInput: string): string {
  const ctx = getExecutionContext();
  const turnId = uuid();
  const questionAudit = captureAuditContent(userInput);

  const turn: TelemetryTurn = {
    turn_id: turnId,
    session_id: sessionId,
    user_id: ctx?.user?.id ?? 'unknown',
    agent_id: agentId,
    channel: ctx?.channel ?? 'system',
    started_at: Date.now(),
    ended_at: 0,
    ctx_ms: 0,
    llm_total_ms: 0,
    tool_total_ms: 0,
    render_ms: 0,
    loop_rounds: 0,
    total_tool_calls: 0,
    stop_reason: '',
    model: '',
    input_tokens: 0,
    output_tokens: 0,
    tools: [],
    llm_calls: [],
    knowledge_hits: [],
    user_question: userInput.slice(0, 2000),
    user_question_content: questionAudit.content,
    user_question_chars: questionAudit.chars,
    user_question_truncated: questionAudit.truncated,
    answer_preview: '',
    answer_content: '',
    answer_chars: 0,
    answer_truncated: false,
  };

  activeTurns.set(sessionId, turn);
  return turnId;
}

export function recordLLM(
  sessionId: string,
  call: TelemetryLLMCall,
): void {
  const turn = activeTurns.get(sessionId);
  if (!turn) return;
  turn.llm_calls.push(call);
  turn.llm_total_ms += call.duration_ms;
  turn.input_tokens += call.input_tokens;
  turn.output_tokens += call.output_tokens;
  if (!turn.model) turn.model = call.model;
}

export function recordTool(
  sessionId: string,
  call: TelemetryToolCall,
): void {
  const turn = activeTurns.get(sessionId);
  if (!turn) return;
  turn.tools.push(call);
  turn.total_tool_calls++;
  turn.tool_total_ms += call.duration_ms;
}

export function recordKnowledge(
  sessionId: string,
  hit: TelemetryKnowledgeHit,
): void {
  const turn = activeTurns.get(sessionId);
  if (!turn) return;
  turn.knowledge_hits.push(hit);
}

export function endTurn(
  sessionId: string,
  opts: {
    loop_rounds: number;
    stop_reason: string;
    answer_preview: string;
    ctx_ms: number;
    render_ms: number;
  },
): TelemetryTurn | null {
  const turn = activeTurns.get(sessionId);
  if (!turn) return null;

  turn.ended_at = Date.now();
  turn.loop_rounds = opts.loop_rounds;
  turn.stop_reason = opts.stop_reason;
  turn.answer_preview = opts.answer_preview.slice(0, 500);
  const answerAudit = captureAuditContent(opts.answer_preview);
  turn.answer_content = answerAudit.content;
  turn.answer_chars = answerAudit.chars;
  turn.answer_truncated = answerAudit.truncated;
  turn.ctx_ms = opts.ctx_ms;
  turn.render_ms = opts.render_ms;

  activeTurns.delete(sessionId);

  // Write JSONL synchronously
  try {
    ensureLogsDir();
    const outputPath = jsonlPath();
    fs.appendFileSync(outputPath, JSON.stringify(turn) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.chmodSync(outputPath, 0o600);
  } catch (e: any) {
    // JSONL write failure is non-fatal
  }

  // Write SQLite — better-sqlite3 is synchronous and fast (<1ms in WAL)
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO telemetry_turn (
        turn_id, session_id, user_id, agent_id, channel,
        started_at, ended_at,
        ctx_ms, llm_total_ms, tool_total_ms, render_ms,
        loop_rounds, total_tool_calls, stop_reason,
        model, input_tokens, output_tokens,
        tools_json, llm_calls_json, knowledge_hits_json,
        user_question, answer_preview,
        user_question_content, answer_content,
        user_question_chars, answer_chars,
        user_question_truncated, answer_truncated
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?
      )
    `).run(
      turn.turn_id, turn.session_id, turn.user_id, turn.agent_id, turn.channel,
      turn.started_at, turn.ended_at,
      turn.ctx_ms, turn.llm_total_ms, turn.tool_total_ms, turn.render_ms,
      turn.loop_rounds, turn.total_tool_calls, turn.stop_reason,
      turn.model, turn.input_tokens, turn.output_tokens,
      JSON.stringify(turn.tools), JSON.stringify(turn.llm_calls), JSON.stringify(turn.knowledge_hits),
      turn.user_question, turn.answer_preview,
      turn.user_question_content, turn.answer_content,
      turn.user_question_chars, turn.answer_chars,
      turn.user_question_truncated ? 1 : 0, turn.answer_truncated ? 1 : 0,
    );
  } catch (e: any) {
    // SQLite write failure is non-fatal; turn is already in JSONL
  }

  return turn;
}

/** Get the active turn for a session (for inspection / testing) */
export function getActiveTurn(sessionId: string): TelemetryTurn | undefined {
  return activeTurns.get(sessionId);
}
