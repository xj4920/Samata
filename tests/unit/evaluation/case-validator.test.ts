import { describe, expect, it } from 'vitest';
import { validateScenarioCase, validateTaxonomy } from '../../../src/evaluation/case-validator.js';
import type { ScenarioCase, ScenarioTaxonomy } from '../../../src/evaluation/types.js';

const taxonomy: ScenarioTaxonomy = {
  version: 1,
  scenarios: [{ id: 'direct_answer', name: '普通问答', description: '测试' }],
};

function validCase(): ScenarioCase {
  return {
    version: 1,
    id: 'direct-answer-001',
    title: '普通问答',
    scenario: 'direct_answer',
    status: 'approved',
    risk: 'low',
    priority: 1,
    tags: ['happy_path'],
    input: { text: '请解释概念', agent: 'standard-test', role: 'admin', channel: 'cli' },
    fixtures: [],
    assertions: { forbiddenTools: ['send_file'] },
    judge: { enabled: false },
    execution: { mode: 'self-test', repetitions: 1, timeoutMs: 1000 },
    review: { reviewedBy: 'test', reviewedAt: '2026-07-21' },
  };
}

describe('scenario case validator', () => {
  it('accepts a complete approved case', () => {
    expect(validateScenarioCase(validCase(), taxonomy)).toEqual({ valid: true, issues: [] });
  });

  it('rejects unknown scenarios and missing approval metadata', () => {
    const value = validCase() as any;
    value.scenario = 'unknown';
    delete value.review;
    const result = validateScenarioCase(value, taxonomy);
    expect(result.valid).toBe(false);
    expect(result.issues.map(issue => issue.path)).toEqual(expect.arrayContaining(['scenario', 'review']));
  });

  it('rejects duplicate fixture tools and malformed matchers', () => {
    const value = validCase() as any;
    value.fixtures = [
      { tool: 'lookup', responses: [{ input: { mode: 'subset' }, output: {} }] },
      { tool: 'lookup', responses: [{ output: {} }] },
    ];
    const result = validateScenarioCase(value, taxonomy);
    expect(result.valid).toBe(false);
    expect(result.issues.some(issue => issue.path.endsWith('.value'))).toBe(true);
    expect(result.issues.some(issue => issue.message.includes('同一工具'))).toBe(true);
  });
});

describe('taxonomy validator', () => {
  it('rejects duplicate taxonomy ids', () => {
    const result = validateTaxonomy({
      version: 1,
      scenarios: [
        { id: 'same', name: '一', description: '一' },
        { id: 'same', name: '二', description: '二' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some(issue => issue.message.includes('重复场景'))).toBe(true);
  });
});
