import { describe, expect, it } from 'vitest';
import { runScenarioCase } from '../../../src/evaluation/runner.js';
import type { ScenarioCase } from '../../../src/evaluation/types.js';

function scenarioCase(): ScenarioCase {
  return {
    version: 1,
    id: 'query-001',
    title: '查询',
    scenario: 'business_query',
    status: 'approved',
    risk: 'high',
    priority: 1,
    tags: ['happy_path'],
    input: { text: '查询数据', agent: 'standard-test', role: 'admin', channel: 'cli' },
    fixtures: [],
    assertions: {
      requiredTools: [{ tool: 'lookup', minCalls: 1, maxCalls: 1 }],
      allowedTools: ['lookup'],
      requiredFacts: ['42'],
      forbiddenClaims: ['失败'],
      maxToolCalls: 1,
    },
    judge: { enabled: true, minScore: 0.8, criteria: ['正确'] },
    execution: { mode: 'self-test', repetitions: 2, timeoutMs: 1000 },
    review: { reviewedBy: 'test', reviewedAt: '2026-07-21' },
  };
}

describe('scenario runner', () => {
  it('combines hard assertions and judge results across repetitions', async () => {
    const result = await runScenarioCase(
      scenarioCase(),
      async (_case, repetition) => ({
        caseId: 'query-001',
        repetition,
        answer: '结果是 42',
        toolCalls: [{ tool: 'lookup', input: {}, output: '42', success: true }],
        loopRounds: 2,
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 20,
      }),
      async () => ({ status: 'passed', score: 0.9 }),
    );
    expect(result.status).toBe('passed');
    expect(result.passRate).toBe(1);
    expect(result.medianJudgeScore).toBe(0.9);
  });

  it('does not let a passing judge override hard assertion failures', async () => {
    const result = await runScenarioCase(
      { ...scenarioCase(), execution: { mode: 'self-test', repetitions: 1, timeoutMs: 1000 } },
      async () => ({
        caseId: 'query-001', repetition: 1, answer: '没有结果', toolCalls: [], loopRounds: 1,
        inputTokens: 1, outputTokens: 1, durationMs: 1,
      }),
      async () => ({ status: 'passed', score: 1 }),
    );
    expect(result.status).toBe('failed');
    expect(result.repetitions[0].assertions.some(check => !check.passed)).toBe(true);
  });
});
