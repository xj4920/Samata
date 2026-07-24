import { describe, expect, it } from 'vitest';
import { loadCanaryCases, loadContractCases } from '../../../src/evaluation/live-loader.js';
import { validateCanaryCase, validateContractCase } from '../../../src/evaluation/live-validator.js';

function contract(): Record<string, unknown> {
  return {
    version: 1,
    id: 'contract-test',
    title: '契约',
    status: 'approved',
    risk: 'medium',
    target: 'staging',
    safety: 'read_only',
    tags: ['test'],
    steps: [{ id: 'search', tool: 'search_knowledge', input: { keyword: 'x' }, assertions: {} }],
    execution: { timeoutMs: 1000 },
    review: { reviewedBy: 'test', reviewedAt: '2026-07-23' },
  };
}

function canary(): Record<string, unknown> {
  return {
    version: 1,
    id: 'canary-test',
    title: 'Canary',
    status: 'approved',
    risk: 'medium',
    target: 'production',
    safety: 'read_only',
    tags: ['test'],
    input: { text: 'query' },
    allowedTools: ['search_knowledge'],
    assertions: {
      allowedTools: ['search_knowledge'],
      requiredTools: [{ tool: 'search_knowledge', minCalls: 1, maxCalls: 1 }],
    },
    execution: { repetitions: 1, timeoutMs: 1000 },
    review: { reviewedBy: 'test', reviewedAt: '2026-07-23' },
  };
}

describe('live case validator', () => {
  it('loads every checked-in contract and canary asset', () => {
    expect(loadContractCases().length).toBeGreaterThanOrEqual(10);
    expect(loadCanaryCases().length).toBeGreaterThanOrEqual(5);
  });

  it('accepts complete contract and canary cases', () => {
    expect(validateContractCase(contract())).toEqual({ valid: true, issues: [] });
    expect(validateCanaryCase(canary())).toEqual({ valid: true, issues: [] });
  });

  it('rejects malformed assertion collections without throwing', () => {
    const value = contract();
    (value.steps as any[])[0].assertions = { types: {}, invariants: 'bad' };
    const result = validateContractCase(value);
    expect(result.valid).toBe(false);
    expect(result.issues.map(issue => issue.path)).toEqual(expect.arrayContaining([
      'steps[0].assertions.types',
      'steps[0].assertions.invariants',
    ]));
  });

  it('rejects canary tools outside allowlist and excessive repetitions', () => {
    const value = canary();
    (value.assertions as any).requiredTools = [{ tool: 'send_file', minCalls: 1 }];
    (value.execution as any).repetitions = 4;
    const result = validateCanaryCase(value);
    expect(result.valid).toBe(false);
    expect(result.issues.some(issue => issue.message.includes('不在 case allowedTools'))).toBe(true);
    expect(result.issues.some(issue => issue.message.includes('最多重复 3 次'))).toBe(true);
  });
});
