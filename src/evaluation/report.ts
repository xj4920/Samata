import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import type { ScenarioCase, ScenarioCaseRunResult, ScenarioRunManifest } from './types.js';
import { scenarioCaseSetHash } from './case-loader.js';

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function createScenarioRunManifest(input: {
  suite: string;
  cases: ScenarioCase[];
  results: ScenarioCaseRunResult[];
  provider: string;
  model: string;
  judgeProvider?: string;
  judgeModel?: string;
}): ScenarioRunManifest {
  return {
    runId: randomUUID(),
    suite: input.suite,
    createdAt: new Date().toISOString(),
    gitSha: git(['rev-parse', 'HEAD']),
    gitDirty: git(['status', '--porcelain']) !== '',
    caseSetHash: scenarioCaseSetHash(input.cases),
    provider: input.provider,
    model: input.model,
    judgeProvider: input.judgeProvider,
    judgeModel: input.judgeModel,
    cases: input.results,
  };
}

function metricMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function scenarioRunMarkdown(manifest: ScenarioRunManifest): string {
  const statusCounts = new Map<string, number>();
  for (const result of manifest.cases) statusCounts.set(result.status, (statusCounts.get(result.status) ?? 0) + 1);
  const lines = [
    `# 场景回归报告：${manifest.suite}`,
    '',
    `- Run ID：${manifest.runId}`,
    `- 时间：${manifest.createdAt}`,
    `- Git：${manifest.gitSha}${manifest.gitDirty ? '（dirty）' : ''}`,
    `- Case set hash：${manifest.caseSetHash}`,
    `- Model：${manifest.provider}/${manifest.model}`,
    `- Case：${manifest.cases.length}`,
    `- 状态：${[...statusCounts.entries()].map(([status, count]) => `${status}=${count}`).join(', ') || '无'}`,
    '',
    '| Case | 场景 | 风险 | 状态 | 通过率 | Judge 中位分 | 耗时中位数 | 工具调用中位数 |',
    '|---|---|---|---|---:|---:|---:|---:|',
    ...manifest.cases.map(result => {
      const duration = metricMedian(result.repetitions.map(item => item.metrics.durationMs));
      const tools = metricMedian(result.repetitions.map(item => item.metrics.toolCalls));
      return `| ${escapeCell(result.caseId)} | ${escapeCell(result.scenario)} | ${result.risk} | ${result.status} | ${(result.passRate * 100).toFixed(0)}% | ${result.medianJudgeScore?.toFixed(3) ?? '—'} | ${duration.toFixed(0)}ms | ${tools.toFixed(1)} |`;
    }),
    '',
  ];

  const failures = manifest.cases.filter(item => item.status !== 'passed');
  if (failures.length > 0) {
    lines.push('## 失败与不确定项', '');
    for (const failure of failures) {
      lines.push(`### ${failure.caseId}`, '');
      for (const repetition of failure.repetitions.filter(item => item.status !== 'passed')) {
        lines.push(`- 第 ${repetition.repetition} 次：${repetition.status}${repetition.error ? `；${repetition.error}` : ''}`);
        for (const check of repetition.assertions.filter(item => !item.passed)) lines.push(`  - ${check.message}`);
        if (repetition.judge?.error) lines.push(`  - Judge：${repetition.judge.error}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function stripSensitiveRunDetails(manifest: ScenarioRunManifest): ScenarioRunManifest {
  return {
    ...manifest,
    cases: manifest.cases.map(caseResult => ({
      ...caseResult,
      repetitions: caseResult.repetitions.map(repetition => ({
        ...repetition,
        answer: undefined,
        toolTrace: undefined,
        assertions: repetition.assertions.map(check => ({
          id: check.id,
          passed: check.passed,
          message: check.message,
        })),
      })),
    })),
  };
}
