import { describe, expect, it } from 'vitest';
import { evaluateScenarioGate, type ScenarioGateConfig } from '../../../src/evaluation/gate.js';
import type { ScenarioRunManifest } from '../../../src/evaluation/types.js';

const config: ScenarioGateConfig = {
  version: 1,
  critical: { hardAssertionPassRate: 1, repetitionPassRate: 1, judgeScoreTolerance: 0 },
  default: { hardAssertionPassRate: 1, repetitionPassRate: 2 / 3, judgeScoreTolerance: 0.05 },
  metrics: { durationRegressionWarningRatio: 0.5 },
};

function manifest(status: 'passed' | 'failed', durationMs = 10): ScenarioRunManifest {
  return {
    runId: status,
    suite: 'test',
    createdAt: '2026-07-21T00:00:00Z',
    gitSha: 'abc',
    gitDirty: false,
    caseSetHash: 'same',
    provider: 'mock',
    model: 'mock',
    cases: [{
      caseId: 'case-1', scenario: 'direct_answer', risk: 'low', status,
      passRate: status === 'passed' ? 1 : 0,
      medianJudgeScore: status === 'passed' ? 0.9 : 0.6,
      repetitions: [{
        repetition: 1,
        status,
        assertions: [{ id: 'hard', passed: status === 'passed', message: 'hard' }],
        metrics: { durationMs, toolCalls: 0, loopRounds: 1, inputTokens: 5, outputTokens: 5 },
      }],
    }],
  };
}

describe('scenario gate', () => {
  it('passes clean runs and emits metric warnings', () => {
    const result = evaluateScenarioGate(manifest('passed', 20), config, manifest('passed', 10));
    expect(result.passed).toBe(true);
    expect(result.warnings[0]).toContain('耗时');
  });

  it('fails hard assertion and baseline status regressions', () => {
    const result = evaluateScenarioGate(manifest('failed'), config, manifest('passed'));
    expect(result.passed).toBe(false);
    expect(result.failures.some(message => message.includes('硬断言'))).toBe(true);
    expect(result.failures.some(message => message.includes('退化'))).toBe(true);
  });
});
