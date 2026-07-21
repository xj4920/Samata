import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTelemetryCandidates } from '../../../src/evaluation/telemetry-reader.js';
import type { ScenarioTaxonomy } from '../../../src/evaluation/types.js';

const dirs: string[] = [];
const taxonomy: ScenarioTaxonomy = {
  version: 1,
  scenarios: [
    { id: 'direct_answer', name: '普通问答', description: '无工具' },
    { id: 'business_query', name: '业务查询', description: '查询' },
    { id: 'incident_investigation', name: '问题调查', description: '调查' },
    { id: 'complex_workflow', name: '复杂', description: '复杂' },
  ],
};

function telemetry(overrides: Record<string, unknown> = {}) {
  return {
    turn_id: 'private-turn-id',
    agent_id: '11111111-2222-4333-8444-555555555555',
    channel: 'wework',
    started_at: Date.parse('2026-06-01T00:00:00Z'),
    ended_at: Date.parse('2026-06-01T00:00:01Z'),
    ctx_ms: 10,
    llm_total_ms: 20,
    tool_total_ms: 30,
    render_ms: 40,
    loop_rounds: 2,
    total_tool_calls: 1,
    stop_reason: 'end_turn',
    input_tokens: 100,
    output_tokens: 20,
    user_question: '查询 test@example.com 的数据',
    answer_preview: '已完成',
    tools: [{ name: 'query_trades', round: 1, success: true, input: '{"token":"raw"}', output_preview: 'ok' }],
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('telemetry candidate reader', () => {
  it('filters, redacts, classifies and deduplicates telemetry turns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samata-eval-'));
    dirs.push(dir);
    const file = join(dir, 'telemetry.jsonl');
    writeFileSync(file, [
      JSON.stringify(telemetry()),
      JSON.stringify(telemetry({ turn_id: 'turn-2' })),
      '{broken',
    ].join('\n'));

    const result = readTelemetryCandidates([file], taxonomy);
    expect(result.totalTurns).toBe(2);
    expect(result.eligibleTurns).toBe(2);
    expect(result.malformedLines).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].clusterSize).toBe(2);
    expect(result.candidates[0].scenario).toBe('business_query');
    expect(result.candidates[0].question).toContain('[REDACTED_EMAIL]');
    expect(result.candidates[0].toolCalls[0].input).not.toContain('raw');
    expect(result.candidates[0].agent).not.toContain('11111111');
    expect(result.candidates[0].turnHash).not.toContain('private-turn-id');
  });

  it('recognizes code/log investigation trajectories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'samata-eval-'));
    dirs.push(dir);
    const file = join(dir, 'telemetry.jsonl');
    writeFileSync(file, JSON.stringify(telemetry({
      tools: [{ name: 'mcp_logyi_logyi_submit_search', round: 1, success: true }],
    })));
    expect(readTelemetryCandidates([file], taxonomy).candidates[0].scenario).toBe('incident_investigation');
  });
});
