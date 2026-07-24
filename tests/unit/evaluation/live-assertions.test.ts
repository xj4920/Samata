import { describe, expect, it } from 'vitest';
import { evaluateCanaryAssertions, evaluateLiveOutputAssertions } from '../../../src/evaluation/live-assertions.js';
import { getLivePath } from '../../../src/evaluation/live-value.js';

describe('live assertions', () => {
  it('reads dot and bracket array paths', () => {
    const value = { documents: [{ id: 'doc-1' }] };
    expect(getLivePath(value, 'documents.0.id')).toBe('doc-1');
    expect(getLivePath(value, 'documents[0].id')).toBe('doc-1');
  });

  it('finds a marker nested inside an array of tool result objects', () => {
    const checks = evaluateLiveOutputAssertions({
      contains: [{ path: '$', value: 'SYNTHETIC-CLIENT-001' }],
    }, {
      rawOutput: '',
      parsedOutput: [{ id: 'client-1', name: 'SYNTHETIC-CLIENT-001' }],
      success: true,
      durationMs: 1,
    });
    expect(checks.every(check => check.passed)).toBe(true);
  });

  it('checks structure, values, ratio, date order and duration', () => {
    const checks = evaluateLiveOutputAssertions({
      requiredPaths: ['totals.used', 'totals.limit'],
      types: [{ path: 'totals.used', type: 'number' }],
      contains: [{ path: '$', value: 'CANARY' }],
      invariants: [
        { op: 'gte', left: { path: 'totals.limit' }, right: { path: 'totals.used' } },
        {
          op: 'approx_ratio',
          result: { path: 'totals.ratio' },
          numerator: { path: 'totals.used' },
          denominator: { path: 'totals.limit' },
        },
        { op: 'date_order', start: { path: 'from' }, end: { path: 'to' } },
      ],
      maxDurationMs: 100,
    }, {
      rawOutput: '',
      parsedOutput: {
        marker: 'CANARY',
        from: '2026-07-01',
        to: '2026-07-23',
        totals: { used: 40, limit: 100, ratio: 0.4 },
      },
      success: true,
      durationMs: 20,
    });
    expect(checks.every(check => check.passed)).toBe(true);
  });

  it('checks canary tool order and answer boundaries', () => {
    const checks = evaluateCanaryAssertions({
      allowedTools: ['search_knowledge', 'read_knowledge_document'],
      requiredTools: [{ tool: 'search_knowledge', minCalls: 1, maxCalls: 1 }],
      toolOrder: ['search_knowledge', 'read_knowledge_document'],
      requiredFacts: ['KB-CANARY'],
      forbiddenClaims: ['未经检索'],
      maxToolCalls: 2,
      maxLoopRounds: 3,
    }, {
      answer: '依据文档，事实为 KB-CANARY。',
      toolCalls: [
        { tool: 'search_knowledge', input: {}, output: '{}', success: true },
        { tool: 'read_knowledge_document', input: {}, output: '{}', success: true },
      ],
      loopRounds: 2,
    });
    expect(checks.every(check => check.passed)).toBe(true);
  });
});
