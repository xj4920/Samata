import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDb = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/connection.js', () => ({ getDb: mockGetDb }));

describe('telemetry audit content', () => {
  let db: Database.Database;
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samata-telemetry-audit-'));
    process.chdir(tmpDir);
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE telemetry_turn (
        turn_id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, agent_id TEXT, channel TEXT,
        started_at INTEGER, ended_at INTEGER, ctx_ms INTEGER, llm_total_ms INTEGER,
        tool_total_ms INTEGER, render_ms INTEGER, loop_rounds INTEGER,
        total_tool_calls INTEGER, stop_reason TEXT, model TEXT, input_tokens INTEGER,
        output_tokens INTEGER, tools_json TEXT, llm_calls_json TEXT,
        knowledge_hits_json TEXT, user_question TEXT, answer_preview TEXT,
        user_question_content TEXT, answer_content TEXT, user_question_chars INTEGER,
        answer_chars INTEGER, user_question_truncated INTEGER, answer_truncated INTEGER
      );
    `);
    mockGetDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('stores bounded full question and answer content in JSONL and SQLite', async () => {
    const question = `Q${'x'.repeat(100_000)}`;
    const answer = `A${'y'.repeat(100_000)}`;
    const { runWithExecutionContext } = await import(
      '../../../src/runtime/execution-context.js'
    );
    const { startTurn, endTurn } = await import('../../../src/telemetry/emitter.js');

    runWithExecutionContext({
      channel: 'wework',
      user: { id: 'user-1', username: 'u1', role: 'user' },
    }, () => {
      startTurn('session-1', 'agent-ticlaw', question);
      endTurn('session-1', {
        loop_rounds: 1,
        stop_reason: 'end_turn',
        answer_preview: answer,
        ctx_ms: 1,
        render_ms: 2,
      });
    });

    const row = db.prepare(`
      SELECT user_question, answer_preview, user_question_content, answer_content,
             user_question_chars, answer_chars, user_question_truncated, answer_truncated
      FROM telemetry_turn
    `).get() as Record<string, string | number>;
    expect(row.user_question).toHaveLength(2000);
    expect(row.answer_preview).toHaveLength(500);
    expect(row.user_question_content).toHaveLength(100_000);
    expect(row.answer_content).toHaveLength(100_000);
    expect(row.user_question_chars).toBe(100_001);
    expect(row.answer_chars).toBe(100_001);
    expect(row.user_question_truncated).toBe(1);
    expect(row.answer_truncated).toBe(1);

    const jsonl = fs.readdirSync(path.join(tmpDir, 'logs'))
      .find(name => name.startsWith('telemetry-'))!;
    const event = JSON.parse(fs.readFileSync(path.join(tmpDir, 'logs', jsonl), 'utf8'));
    expect(event.user_question_content).toHaveLength(100_000);
    expect(event.answer_content).toHaveLength(100_000);
    expect(fs.statSync(path.join(tmpDir, 'logs', jsonl)).mode & 0o777).toBe(0o600);
  });
});
