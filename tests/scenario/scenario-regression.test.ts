import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadScenarioCases } from '../../src/evaluation/case-loader.js';
import { judgeScenarioAnswer } from '../../src/evaluation/judge.js';
import { createScenarioRunManifest, scenarioRunMarkdown } from '../../src/evaluation/report.js';
import { runScenarioCase } from '../../src/evaluation/runner.js';
import type { ScenarioCaseRunResult } from '../../src/evaluation/types.js';
import { closeScenarioRuntime, executeScenarioWithCurrentAgent } from './helpers/scenario-runtime.js';

const allApproved = loadScenarioCases({ statuses: ['approved'] });
const suite = process.env.EVAL_SUITE ?? 'smoke';
const selected = suite === 'smoke'
  ? [...new Map(allApproved.sort((a, b) => a.priority - b.priority).map(item => [item.scenario, item])).values()]
  : allApproved;
const results: ScenarioCaseRunResult[] = [];

describe('场景回归评测', () => {
  if (selected.length === 0) {
    it('需要至少一个 approved case', () => {
      throw new Error('没有 approved 场景 case；请先完成候选脱敏、fixture 补齐和人工审核');
    });
  }

  for (const originalCase of selected) {
    it(`${originalCase.scenario} / ${originalCase.id}`, async () => {
      const scenarioCase = suite === 'smoke'
        ? { ...originalCase, execution: { ...originalCase.execution, repetitions: 1 } }
        : originalCase;
      const judge = scenarioCase.judge.enabled
        ? async (caseInput: typeof scenarioCase, execution: Parameters<typeof judgeScenarioAnswer>[3]) => {
            const { getModelForTask, getProviderForTask } = await import('../../src/llm/provider.js');
            const provider = getProviderForTask('scoring');
            return judgeScenarioAnswer(provider, getModelForTask('scoring'), caseInput, execution);
          }
        : undefined;
      const result = await runScenarioCase(scenarioCase, executeScenarioWithCurrentAgent, judge);
      results.push(result);
      expect(result.status).toBe('passed');
    });
  }
});

afterAll(async () => {
  closeScenarioRuntime();
  if (results.length === 0) return;
  const { getModelName, getProviderName } = await import('../../src/llm/provider.js');
  const manifest = createScenarioRunManifest({
    suite,
    cases: selected,
    results,
    provider: getProviderName(),
    model: getModelName(),
    judgeProvider: process.env.PROVIDER_SCORING,
    judgeModel: process.env.MODEL_SCORING,
  });
  const output = resolve(process.env.EVAL_OUTPUT ?? `data/evaluation/runs/${suite}-${manifest.runId}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(output.replace(/\.json$/, '.md'), scenarioRunMarkdown(manifest), 'utf8');
  console.log(`场景评测结果: ${output}`);
});
