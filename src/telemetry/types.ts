/** Single tool call record within a turn */
export interface TelemetryToolCall {
  name: string;
  round: number;
  duration_ms: number;
  success: boolean;
  bytes: number;
  error?: string;
  input?: string;
  output_preview?: string;
}

/** Single LLM call record within a turn */
export interface TelemetryLLMCall {
  round: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string;
  duration_ms: number;
}

/** Single knowledge search record within a turn */
export interface TelemetryKnowledgeHit {
  keyword: string;
  hits: number;
  agent_id: string;
}

/**
 * Unified event model: one agentic interaction = one TelemetryTurn.
 * Written to JSONL (logs/telemetry-YYYY-MM-DD.jsonl) and SQLite (telemetry_turn).
 */
export interface TelemetryTurn {
  turn_id: string;
  session_id: string;
  user_id: string;
  agent_id: string;
  channel: string;

  started_at: number; // Date.now()
  ended_at: number;

  // Segment timing (ms)
  ctx_ms: number;
  llm_total_ms: number;
  tool_total_ms: number;
  render_ms: number;

  // Loop stats
  loop_rounds: number;
  total_tool_calls: number;
  stop_reason: string;

  // LLM aggregate (summed across rounds)
  model: string;
  input_tokens: number;
  output_tokens: number;

  // Sub-arrays
  tools: TelemetryToolCall[];
  llm_calls: TelemetryLLMCall[];
  knowledge_hits: TelemetryKnowledgeHit[];

  // User's original question (text + optional image hints)
  user_question: string;

  // Audit content. Preview fields above remain bounded for prompt/report usage;
  // these fields preserve the user-visible turn content for daily auditing.
  user_question_content: string;
  user_question_chars: number;
  user_question_truncated: boolean;

  // Final answer preview (first 500 chars for quick scan)
  answer_preview: string;
  answer_content: string;
  answer_chars: number;
  answer_truncated: boolean;
}
