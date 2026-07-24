import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

function telemetry(overrides: Record<string, unknown>) {
  return {
    turn_id: 'turn-default',
    session_id: 'session-default',
    user_id: 'user-1',
    agent_id: 'agent-ticlaw',
    channel: 'wework',
    started_at: Date.parse('2026-07-22T16:30:00.000Z'),
    ended_at: Date.parse('2026-07-22T16:31:00.000Z'),
    ctx_ms: 10,
    llm_total_ms: 20,
    tool_total_ms: 30,
    render_ms: 5,
    loop_rounds: 1,
    total_tool_calls: 1,
    stop_reason: 'end_turn',
    model: 'test-model',
    input_tokens: 10,
    output_tokens: 20,
    tools: [{
      name: 'search_knowledge',
      round: 1,
      duration_ms: 30,
      success: true,
      bytes: 12,
      input: '{"query":"test"}',
      output_preview: 'hit',
    }],
    llm_calls: [],
    knowledge_hits: [],
    user_question: 'legacy-question',
    answer_preview: 'legacy-answer',
    user_question_content: 'question-default',
    answer_content: 'answer-default',
    user_question_chars: 16,
    answer_chars: 14,
    user_question_truncated: false,
    answer_truncated: false,
    ...overrides,
  };
}

describe('daily session audit analyzer', () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('reads adjacent UTC files and keeps only the requested Chongqing date and agents', () => {
    root = mkdtempSync(join(tmpdir(), 'samata-analyze-session-audit-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'logs'), { recursive: true });
    const db = new Database(join(root, 'data/samata.db'));
    db.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT);
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT);
      INSERT INTO agents VALUES ('agent-ticlaw', 'ticlaw', 'Ticlaw');
      INSERT INTO agents VALUES ('agent-otcclaw', 'otcclaw', 'Otcclaw');
    `);
    db.close();

    const previousUtcFile = [
      telemetry({
        turn_id: 'excluded-previous-local-day',
        started_at: Date.parse('2026-07-22T15:30:00.000Z'),
        ended_at: Date.parse('2026-07-22T15:31:00.000Z'),
        user_question_content: 'question-before-day',
      }),
      telemetry({
        turn_id: 'included-early',
        user_question_content: 'question-early',
        answer_content: 'answer-early',
      }),
    ];
    const currentUtcFile = [
      telemetry({
        turn_id: 'included-late',
        agent_id: 'agent-otcclaw',
        started_at: Date.parse('2026-07-23T15:20:00.000Z'),
        ended_at: Date.parse('2026-07-23T15:21:00.000Z'),
        user_question_content: 'question-late',
        answer_content: 'answer-late',
        tools: [{
          name: 'tool-with-control-char',
          round: 1,
          duration_ms: 30,
          success: true,
          bytes: 12,
          input: 'nul\u0000and-unpaired\uD800',
          output_preview: 'ok',
        }],
      }),
      telemetry({
        turn_id: 'excluded-next-local-day',
        started_at: Date.parse('2026-07-23T16:30:00.000Z'),
        ended_at: Date.parse('2026-07-23T16:31:00.000Z'),
        user_question_content: 'question-after-day',
      }),
      telemetry({
        turn_id: 'excluded-cli',
        channel: 'cli',
        started_at: Date.parse('2026-07-23T12:00:00.000Z'),
        ended_at: Date.parse('2026-07-23T12:01:00.000Z'),
        user_question_content: 'question-cli',
      }),
      telemetry({
        turn_id: 'excluded-agent',
        agent_id: 'agent-admin',
        started_at: Date.parse('2026-07-23T12:30:00.000Z'),
        ended_at: Date.parse('2026-07-23T12:31:00.000Z'),
        user_question_content: 'question-other-agent',
      }),
    ];
    writeFileSync(
      join(root, 'logs/telemetry-2026-07-22.jsonl'),
      `${previousUtcFile.map(row => JSON.stringify(row)).join('\n')}\n`,
    );
    writeFileSync(
      join(root, 'logs/telemetry-2026-07-23.jsonl'),
      `${currentUtcFile.map(row => JSON.stringify(row)).join('\n')}\n`,
    );

    execFileSync(process.execPath, [
      '--import',
      resolve(process.cwd(), 'node_modules/tsx/dist/esm/index.mjs'),
      resolve(process.cwd(), 'scripts/analyze-log.ts'),
      '--source=telemetry',
      '--from=2026-07-23',
      '--to=2026-07-23',
      '--agents=ticlaw,otcclaw',
      '--human-only',
      '--quiet',
    ], { cwd: root, stdio: 'pipe' });

    const report = readFileSync(
      join(root, 'logs/daily_usage/2026-07-23_telemetry_ticlaw-otcclaw.md'),
      'utf8',
    );
    expect(report).toContain('共 2 条');
    expect(report).toContain('question-early');
    expect(report).toContain('answer-early');
    expect(report).toContain('question-late');
    expect(report).toContain('answer-late');
    expect(report).not.toContain('question-before-day');
    expect(report).not.toContain('question-after-day');
    expect(report).not.toContain('question-cli');
    expect(report).not.toContain('question-other-agent');
  });
});
