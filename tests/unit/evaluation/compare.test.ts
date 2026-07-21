import { describe, expect, it } from 'vitest';
import { compareScenarioRuns } from '../../../src/evaluation/compare.js';
import type { ScenarioRunManifest } from '../../../src/evaluation/types.js';

function manifest(status: 'passed' | 'failed', runId: string): ScenarioRunManifest {
  return {
    runId,
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
      repetitions: [{
        repetition: 1,
        status,
        assertions: [],
        metrics: { durationMs: 10, toolCalls: 0, loopRounds: 1, inputTokens: 5, outputTokens: 5 },
      }],
    }],
  };
}

describe('scenario baseline comparison', () => {
  it('detects status regressions', () => {
    const comparison = compareScenarioRuns(manifest('passed', 'before'), manifest('failed', 'after'));
    expect(comparison.compatibleCaseSet).toBe(true);
    expect(comparison.regressions.map(item => item.caseId)).toEqual(['case-1']);
  });
});
