import { describe, expect, it } from 'vitest';
import { runCanaryCase } from '../../../src/evaluation/canary-runner.js';
import { runContractCase } from '../../../src/evaluation/contract-runner.js';
import type { CanaryCase, ContractCase } from '../../../src/evaluation/live-types.js';

function contract(): ContractCase {
  return {
    version: 1,
    id: 'contract-chain',
    title: 'chain',
    status: 'approved',
    risk: 'medium',
    target: 'staging',
    safety: 'read_only',
    tags: ['test'],
    steps: [
      {
        id: 'search',
        tool: 'search_knowledge',
        input: { keyword: '${MARKER}' },
        assertions: { requiredPaths: ['documents.0.document_id'] },
      },
      {
        id: 'read',
        tool: 'read_knowledge_document',
        input: { document_id: '{{steps.search.documents.0.document_id}}' },
        assertions: { contains: [{ path: 'content', value: '${MARKER}' }] },
      },
    ],
    execution: { timeoutMs: 1000 },
    review: { reviewedBy: 'test', reviewedAt: '2026-07-23' },
  };
}

function canary(): CanaryCase {
  return {
    version: 1,
    id: 'canary-search',
    title: 'search',
    status: 'approved',
    risk: 'medium',
    target: 'production',
    safety: 'read_only',
    tags: ['test'],
    input: { text: 'find ${MARKER}' },
    allowedTools: ['search_knowledge'],
    assertions: {
      allowedTools: ['search_knowledge'],
      requiredTools: [{ tool: 'search_knowledge', minCalls: 1, maxCalls: 1 }],
      requiredFacts: ['${MARKER}'],
    },
    execution: { repetitions: 2, timeoutMs: 1000 },
    review: { reviewedBy: 'test', reviewedAt: '2026-07-23' },
  };
}

describe('live runners', () => {
  it('passes prior output into the next contract step without persisting raw values', async () => {
    const inputs: unknown[] = [];
    const result = await runContractCase(contract(), async (tool, input) => {
      inputs.push(input);
      return tool === 'search_knowledge'
        ? {
            rawOutput: '{"documents":[{"document_id":"secret-doc"}]}',
            parsedOutput: { documents: [{ document_id: 'secret-doc' }] },
            success: true,
            durationMs: 2,
          }
        : {
            rawOutput: '{"content":"KB-CANARY"}',
            parsedOutput: { content: 'KB-CANARY' },
            success: true,
            durationMs: 2,
          };
    }, { MARKER: 'KB-CANARY' });
    expect(result.status).toBe('passed');
    expect(inputs[1]).toEqual({ document_id: 'secret-doc' });
    expect(result.steps[0].outputPreview).not.toContain('secret-doc');
    expect(result.steps[1].outputPreview).not.toContain('KB-CANARY');
    expect(JSON.stringify(result)).not.toContain('secret-doc');
    expect(JSON.stringify(result)).not.toContain('KB-CANARY');
  });

  it('marks the contract failed and stops after a hard assertion failure', async () => {
    let calls = 0;
    const result = await runContractCase(contract(), async () => {
      calls++;
      return { rawOutput: '{}', parsedOutput: {}, success: true, durationMs: 1 };
    }, { MARKER: 'KB-CANARY' });
    expect(result.status).toBe('failed');
    expect(calls).toBe(1);
  });

  it('requires every canary repetition to pass and redacts answer previews', async () => {
    const result = await runCanaryCase(canary(), async (_item, repetition) => ({
      answer: repetition === 1 ? 'KB-CANARY' : 'missing',
      toolCalls: [{ tool: 'search_knowledge', input: {}, output: '{}', success: true }],
      durationMs: 10,
      loopRounds: 1,
    }), { MARKER: 'KB-CANARY' });
    expect(result.status).toBe('failed');
    expect(result.passRate).toBe(0.5);
    expect(result.repetitions[0].answerPreview).toMatch(/redacted answer/);
    expect(result.repetitions[0].answerPreview).not.toContain('KB-CANARY');
  });
});
