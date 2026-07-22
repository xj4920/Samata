import { afterEach, describe, expect, it } from 'vitest';
import type { ScenarioCase } from '../../../src/evaluation/types.js';
import { MockLLMProvider, textResponse, toolUseResponse } from '../../helpers/mock-provider.js';
import { closeScenarioRuntime, executeScenarioWithCurrentAgent, setScenarioProvider } from '../../scenario/helpers/scenario-runtime.js';

afterEach(() => {
  closeScenarioRuntime();
  delete process.env.EVAL_PROVIDER;
});

describe('scenario runtime integration', () => {
  it('runs the current agent loop while routing tools through frozen fixtures', async () => {
    const provider = new MockLLMProvider([
      toolUseResponse('calculate_date', { operation: 'now' }, 'date-call'),
      textResponse('冻结日期是 2026-07-21'),
    ]);
    setScenarioProvider(provider);
    process.env.EVAL_PROVIDER = 'custom';
    const scenarioCase: ScenarioCase = {
      version: 1,
      id: 'runtime-self-test',
      title: '场景 runtime 自检',
      scenario: 'business_query',
      status: 'approved',
      risk: 'low',
      priority: 1,
      tags: ['happy_path'],
      input: {
        text: '今天是哪一天？',
        agent: 'standard-test',
        role: 'admin',
        channel: 'cli',
        fixedTime: '2026-07-21T00:00:00Z',
      },
      fixtures: [{
        tool: 'calculate_date',
        responses: [{
          input: { mode: 'exact', value: { operation: 'now' } },
          output: { date: '2026-07-21' },
        }],
      }],
      assertions: {
        allowedTools: ['calculate_date'],
        requiredTools: [{ tool: 'calculate_date', minCalls: 1, maxCalls: 1 }],
        requiredFacts: ['2026-07-21'],
      },
      judge: { enabled: false },
      execution: { mode: 'self-test', repetitions: 1, timeoutMs: 10_000 },
      review: { reviewedBy: 'test', reviewedAt: '2026-07-21' },
    };

    const result = await executeScenarioWithCurrentAgent(scenarioCase, 1);
    expect(result.answer).toContain('2026-07-21');
    expect(result.toolCalls.map(call => call.tool)).toEqual(['calculate_date']);
    expect(provider.toolsUsed).toEqual(['calculate_date']);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(scenarioCase.execution.timeoutMs);
  });
});
