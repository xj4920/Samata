import { v4 as uuid } from 'uuid';
import type { TemplateCard } from '@wecom/aibot-node-sdk';
import { getDb } from '../db/connection.js';

export type AnswerFeedbackAction = 'helpful' | 'not_helpful';
export type AnswerFeedbackStatus = 'open' | 'recorded';

export interface AnswerFeedbackRow {
  feedback_id: string;
  turn_id: string | null;
  user_id: string;
  clicked_by_user_id: string | null;
  agent_id: string;
  channel: string;
  app_id: string | null;
  chat_id: string | null;
  rating: 'pending' | AnswerFeedbackAction;
  status: AnswerFeedbackStatus;
  question_preview: string;
  answer_preview: string;
  created_at: string;
  updated_at: string;
}

export interface CreateAnswerFeedbackInput {
  userId: string;
  agentId: string;
  channel: string;
  appId?: string;
  chatId?: string;
  questionPreview?: string;
  answerPreview?: string;
}

export interface CreatedAnswerFeedback {
  feedbackId: string;
  turnId: string | null;
  card: TemplateCard;
}

export interface AnswerFeedbackTurn {
  turn_id: string;
  user_question: string;
  answer_preview: string;
  started_at: number;
  ended_at: number;
  total_tool_calls: number;
}

export interface AnswerFeedbackGateOptions {
  minToolCalls?: number;
  minDurationMs?: number;
}

export interface AnswerFeedbackConfig extends Required<AnswerFeedbackGateOptions> {
  enabled: boolean;
}

const DEFAULT_GATE: Required<AnswerFeedbackGateOptions> = {
  minToolCalls: 10,
  minDurationMs: 60_000,
};

const DEFAULT_CONFIG: AnswerFeedbackConfig = {
  enabled: true,
  minToolCalls: DEFAULT_GATE.minToolCalls,
  minDurationMs: DEFAULT_GATE.minDurationMs,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseAnswerFeedbackConfig(configJson: string | null | undefined): AnswerFeedbackConfig {
  if (!configJson) return { ...DEFAULT_CONFIG };
  try {
    const root = asRecord(JSON.parse(configJson));
    const feedback = asRecord(root?.feedback)
      ?? asRecord(root?.answer_feedback)
      ?? asRecord(root?.wework_feedback);
    if (!feedback) return { ...DEFAULT_CONFIG };

    const minToolCalls = nonNegativeNumber(feedback.minToolCalls)
      ?? nonNegativeNumber(feedback.min_tool_calls)
      ?? DEFAULT_CONFIG.minToolCalls;
    const minDurationMs = nonNegativeNumber(feedback.minDurationMs)
      ?? nonNegativeNumber(feedback.min_duration_ms)
      ?? DEFAULT_CONFIG.minDurationMs;

    return {
      enabled: feedback.enabled === false ? false : DEFAULT_CONFIG.enabled,
      minToolCalls,
      minDurationMs,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function latestTurnFor(input: CreateAnswerFeedbackInput): AnswerFeedbackTurn | null {
  return getDb().prepare(`
    SELECT turn_id, user_question, answer_preview, started_at, ended_at, total_tool_calls
    FROM telemetry_turn
    WHERE user_id = ? AND agent_id = ? AND channel = ?
    ORDER BY ended_at DESC, started_at DESC
    LIMIT 1
  `).get(input.userId, input.agentId, input.channel) as AnswerFeedbackTurn | undefined ?? null;
}

export function shouldCreateAnswerFeedback(
  turn: AnswerFeedbackTurn,
  options: AnswerFeedbackGateOptions = {},
): boolean {
  const gate = { ...DEFAULT_GATE, ...options };
  const durationMs = Math.max(0, turn.ended_at - turn.started_at);
  return turn.total_tool_calls >= gate.minToolCalls || durationMs >= gate.minDurationMs;
}

export function buildWeworkFeedbackCard(feedbackId: string, selected?: AnswerFeedbackAction): TemplateCard {
  const selectedButton: Record<AnswerFeedbackAction, { text: string; style: number }> = {
    helpful: { text: '👍 有帮助', style: 1 },
    not_helpful: { text: '👎 没帮助', style: 2 },
  };

  if (selected) {
    const button = selectedButton[selected];
    return {
      card_type: 'button_interaction',
      main_title: { title: '已记录反馈' },
      button_list: [
        { text: button.text, key: selected, style: button.style },
      ],
      task_id: feedbackId,
    };
  }

  return {
    card_type: 'button_interaction',
    main_title: { title: '这次回答有帮助吗？' },
    button_list: [
      { text: '👍 有帮助', key: 'helpful', style: 1 },
      { text: '👎 没帮助', key: 'not_helpful', style: 2 },
    ],
    task_id: feedbackId,
  };
}

export function createAnswerFeedbackFromLatestTurn(
  input: CreateAnswerFeedbackInput,
  gateOptions?: AnswerFeedbackGateOptions & { enabled?: boolean },
): CreatedAnswerFeedback | null {
  if (gateOptions?.enabled === false) return null;
  const turn = latestTurnFor(input);
  if (!turn || !shouldCreateAnswerFeedback(turn, gateOptions)) return null;

  const feedbackId = `fb_${uuid()}`;
  getDb().prepare(`
    INSERT INTO answer_feedback (
      feedback_id, turn_id, user_id, agent_id, channel, app_id, chat_id,
      question_preview, answer_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    feedbackId,
    turn.turn_id,
    input.userId,
    input.agentId,
    input.channel,
    input.appId ?? null,
    input.chatId ?? null,
    (turn.user_question || input.questionPreview || '').slice(0, 500),
    (turn.answer_preview || input.answerPreview || '').slice(0, 500),
  );

  return {
    feedbackId,
    turnId: turn.turn_id,
    card: buildWeworkFeedbackCard(feedbackId),
  };
}

export function parseWeworkFeedbackEvent(event: {
  event_key?: string;
  key?: string;
  button_key?: string;
  selected_key?: string;
  value?: string;
  task_id?: string;
  template_card_event?: {
    event_key?: string;
    key?: string;
    button_key?: string;
    selected_key?: string;
    value?: string;
    task_id?: string;
  };
}): { feedbackId: string; action: AnswerFeedbackAction } | null {
  const payload = event.template_card_event ?? event;
  if (!payload.task_id?.startsWith('fb_')) return null;
  const eventKey = payload.event_key ?? payload.key ?? payload.button_key ?? payload.selected_key ?? payload.value;
  if (eventKey !== 'helpful' && eventKey !== 'not_helpful') {
    return null;
  }
  return { feedbackId: payload.task_id, action: eventKey };
}

export function recordAnswerFeedbackAction(input: {
  feedbackId: string;
  action: AnswerFeedbackAction;
  clickedByUserId: string;
}): AnswerFeedbackRow | null {
  getDb().prepare(`
    UPDATE answer_feedback
    SET rating = ?,
        status = ?,
        clicked_by_user_id = ?,
        updated_at = datetime('now')
    WHERE feedback_id = ?
  `).run(input.action, 'recorded', input.clickedByUserId, input.feedbackId);

  return getAnswerFeedback(input.feedbackId);
}

export function getAnswerFeedback(feedbackId: string): AnswerFeedbackRow | null {
  return getDb().prepare('SELECT * FROM answer_feedback WHERE feedback_id = ?')
    .get(feedbackId) as AnswerFeedbackRow | undefined ?? null;
}
