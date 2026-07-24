import { describe, expect, it } from 'vitest';
import { interpolateLiveValue, referencedEnvironmentVariables } from '../../../src/evaluation/live-interpolation.js';
import { inspectCanaryGuard, inspectContractGuard, validateLiveToolSafety } from '../../../src/evaluation/live-safety.js';
import type { CanaryCase, ContractCase } from '../../../src/evaluation/live-types.js';

function contract(tool = 'search_knowledge'): ContractCase {
  return {
    version: 1,
    id: 'contract-test',
    title: 'test',
    status: 'approved',
    risk: 'medium',
    target: 'staging',
    safety: 'read_only',
    tags: ['test'],
    requiredEnv: ['MARKER'],
    steps: [{ id: 'one', tool, input: { keyword: '${MARKER}' } }],
    execution: { timeoutMs: 1000 },
    review: { reviewedBy: 'test', reviewedAt: '2026-07-23' },
  };
}

function canary(): CanaryCase {
  return {
    version: 1,
    id: 'canary-test',
    title: 'test',
    status: 'approved',
    risk: 'medium',
    target: 'production',
    safety: 'read_only',
    tags: ['test'],
    input: { text: 'find ${MARKER}' },
    requiredEnv: ['MARKER'],
    allowedTools: ['search_knowledge'],
    assertions: { requiredFacts: ['${MARKER}'] },
    execution: { repetitions: 1, timeoutMs: 1000 },
    review: { reviewedBy: 'test', reviewedAt: '2026-07-23' },
  };
}

describe('live interpolation and safety', () => {
  it('resolves environment and typed prior-step references', () => {
    const output = interpolateLiveValue({
      marker: '${MARKER}',
      id: '{{steps.search.documents.0.document_id}}',
    }, {
      env: { MARKER: 'KB-CANARY' },
      steps: { search: { documents: [{ document_id: 42 }] } },
      strict: true,
    });
    expect(output).toEqual({ marker: 'KB-CANARY', id: 42 });
    expect(referencedEnvironmentVariables(output)).toEqual([]);
    expect(referencedEnvironmentVariables(canary())).toEqual(['MARKER']);
  });

  it('fails closed for unknown tools and wrong contract target', () => {
    expect(validateLiveToolSafety('read_only', ['delete_knowledge'])).toContain(
      '工具 delete_knowledge 未登记 live 安全策略',
    );
    const guard = inspectContractGuard(contract(), {
      EVAL_TARGET: 'production',
      EVAL_USER_ID: 'user',
      EVAL_AGENT_ID: 'agent',
      MARKER: 'x',
    });
    expect(guard.allowed).toBe(false);
    expect(guard.issues.some(issue => issue.includes('拒绝目标环境'))).toBe(true);
  });

  it('requires explicit production switch and dedicated identity', () => {
    const guard = inspectCanaryGuard(canary(), {
      EVAL_TARGET: 'production',
      ALLOW_PROD_CANARY: '0',
      MARKER: 'x',
    });
    expect(guard.allowed).toBe(false);
    expect(guard.missingEnv).toEqual(expect.arrayContaining([
      'CANARY_USER_ID',
      'CANARY_AGENT_ID',
      'CANARY_CHANNEL',
      'CANARY_TARGET_ID',
    ]));
    expect(guard.issues).toContain('Canary live 要求 ALLOW_PROD_CANARY=1');
  });
});
