import { describe, expect, it } from 'vitest';
import { useUnitDb } from '../../helpers/unit-harness.js';

describe('answer feedback service', () => {
  const unit = useUnitDb();

  it('creates a WeWork feedback card with helpful, not helpful, and handoff buttons', async () => {
    const { buildWeworkFeedbackCard } = await import('../../../src/services/answer-feedback.js');

    const card = buildWeworkFeedbackCard('fb_test');

    expect(card.card_type).toBe('button_interaction');
    expect(card.task_id).toBe('fb_test');
    expect(card.button_list?.map(button => button.key)).toEqual(['helpful', 'not_helpful', 'handoff']);
  });

  it('updates the feedback card to only show the selected action', async () => {
    const { buildWeworkFeedbackCard } = await import('../../../src/services/answer-feedback.js');

    const card = buildWeworkFeedbackCard('fb_test', 'not_helpful');

    expect(card.card_type).toBe('button_interaction');
    expect(card.main_title?.title).toBe('已记录反馈');
    expect(card.button_list).toEqual([{ text: '👎 没帮助', key: 'not_helpful', style: 2 }]);
  });

  it('creates feedback from the latest turn only when the work is complex enough', async () => {
    const { createAnswerFeedbackFromLatestTurn } = await import('../../../src/services/answer-feedback.js');

    unit.db.prepare(`
      INSERT INTO telemetry_turn (
        turn_id, session_id, user_id, agent_id, channel,
        started_at, ended_at, user_question, answer_preview, total_tool_calls
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'simple-turn', 'test-user', 'test-user', 'agent-otcclaw', 'wework',
      1000, 2000, '你好', '你好呀', 0,
    );

    const simple = createAnswerFeedbackFromLatestTurn({
      userId: 'test-user',
      agentId: 'agent-otcclaw',
      channel: 'wework',
      appId: 'bot-1',
    });
    expect(simple).toBeNull();

    unit.db.prepare(`
      INSERT INTO telemetry_turn (
        turn_id, session_id, user_id, agent_id, channel,
        started_at, ended_at, user_question, answer_preview, total_tool_calls
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'complex-turn', 'test-user', 'test-user', 'agent-otcclaw', 'wework',
      3000, 5000, '帮我做复杂分析', '复杂分析结果', 10,
    );

    const complex = createAnswerFeedbackFromLatestTurn({
      userId: 'test-user',
      agentId: 'agent-otcclaw',
      channel: 'wework',
      appId: 'bot-1',
    });

    expect(complex?.turnId).toBe('complex-turn');
    const row = unit.db.prepare('SELECT * FROM answer_feedback WHERE feedback_id = ?').get(complex!.feedbackId) as any;
    expect(row.turn_id).toBe('complex-turn');
    expect(row.question_preview).toBe('帮我做复杂分析');
    expect(row.answer_preview).toBe('复杂分析结果');
  });

  it('records a clicked feedback action', async () => {
    const {
      createAnswerFeedbackFromLatestTurn,
      parseWeworkFeedbackEvent,
      recordAnswerFeedbackAction,
    } = await import('../../../src/services/answer-feedback.js');

    unit.db.prepare(`
      INSERT INTO telemetry_turn (
        turn_id, session_id, user_id, agent_id, channel,
        started_at, ended_at, user_question, answer_preview, total_tool_calls
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'turn-for-click', 'test-user', 'test-user', 'agent-otcclaw', 'wework',
      1000, 2000, '用户问题', '机器人回答', 10,
    );

    const created = createAnswerFeedbackFromLatestTurn({
      userId: 'test-user',
      agentId: 'agent-otcclaw',
      channel: 'wework',
      appId: 'bot-1',
    })!;

    const parsed = parseWeworkFeedbackEvent({
      event_key: 'handoff',
      task_id: created.feedbackId,
    });
    expect(parsed).toEqual({ feedbackId: created.feedbackId, action: 'handoff' });

    const recorded = recordAnswerFeedbackAction({
      feedbackId: created.feedbackId,
      action: parsed!.action,
      clickedByUserId: 'wework_user_alice',
    });

    expect(recorded?.rating).toBe('handoff');
    expect(recorded?.status).toBe('handoff_requested');

    const row = unit.db.prepare('SELECT * FROM answer_feedback WHERE feedback_id = ?').get(created.feedbackId) as any;
    expect(row.clicked_by_user_id).toBe('wework_user_alice');
  });

  it('parses compatible WeWork button key fields', async () => {
    const { parseWeworkFeedbackEvent } = await import('../../../src/services/answer-feedback.js');

    expect(parseWeworkFeedbackEvent({
      button_key: 'helpful',
      task_id: 'fb_test',
    })).toEqual({ feedbackId: 'fb_test', action: 'helpful' });
  });

  it('parses nested template_card_event payloads from WeWork callbacks', async () => {
    const { parseWeworkFeedbackEvent } = await import('../../../src/services/answer-feedback.js');

    expect(parseWeworkFeedbackEvent({
      eventtype: 'template_card_event',
      template_card_event: {
        card_type: 'button_interaction',
        event_key: 'not_helpful',
        task_id: 'fb_nested',
      },
    } as any)).toEqual({ feedbackId: 'fb_nested', action: 'not_helpful' });
  });
});
