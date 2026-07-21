import type { ScenarioCaseRunResult, ScenarioRunManifest, ScenarioRunStatus } from './types.js';

export interface ScenarioCaseDiff {
  caseId: string;
  scenario: string;
  baselineStatus?: ScenarioRunStatus;
  currentStatus?: ScenarioRunStatus;
  passRateDelta?: number;
  judgeScoreDelta?: number;
  durationRatio?: number;
  tokenRatio?: number;
  toolCallRatio?: number;
}

export interface ScenarioRunComparison {
  baselineRunId: string;
  currentRunId: string;
  compatibleCaseSet: boolean;
  addedCases: string[];
  removedCases: string[];
  regressions: ScenarioCaseDiff[];
  improvements: ScenarioCaseDiff[];
  diffs: ScenarioCaseDiff[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function ratio(current: number, baseline: number): number | undefined {
  if (baseline === 0) return current === 0 ? 1 : undefined;
  return current / baseline;
}

function metrics(result: ScenarioCaseRunResult): { duration: number; tokens: number; tools: number } {
  return {
    duration: median(result.repetitions.map(item => item.metrics.durationMs)),
    tokens: median(result.repetitions.map(item => item.metrics.inputTokens + item.metrics.outputTokens)),
    tools: median(result.repetitions.map(item => item.metrics.toolCalls)),
  };
}

function statusRank(status?: ScenarioRunStatus): number {
  switch (status) {
    case 'passed': return 4;
    case 'inconclusive': return 3;
    case 'failed': return 2;
    case 'error': return 1;
    default: return 0;
  }
}

export function compareScenarioRuns(
  baseline: ScenarioRunManifest,
  current: ScenarioRunManifest,
): ScenarioRunComparison {
  const baselineMap = new Map(baseline.cases.map(item => [item.caseId, item]));
  const currentMap = new Map(current.cases.map(item => [item.caseId, item]));
  const allIds = [...new Set([...baselineMap.keys(), ...currentMap.keys()])].sort();
  const diffs: ScenarioCaseDiff[] = allIds.map(caseId => {
    const before = baselineMap.get(caseId);
    const after = currentMap.get(caseId);
    const beforeMetrics = before ? metrics(before) : undefined;
    const afterMetrics = after ? metrics(after) : undefined;
    return {
      caseId,
      scenario: after?.scenario ?? before?.scenario ?? 'unknown',
      baselineStatus: before?.status,
      currentStatus: after?.status,
      passRateDelta: before && after ? after.passRate - before.passRate : undefined,
      judgeScoreDelta: before?.medianJudgeScore !== undefined && after?.medianJudgeScore !== undefined
        ? after.medianJudgeScore - before.medianJudgeScore
        : undefined,
      durationRatio: beforeMetrics && afterMetrics ? ratio(afterMetrics.duration, beforeMetrics.duration) : undefined,
      tokenRatio: beforeMetrics && afterMetrics ? ratio(afterMetrics.tokens, beforeMetrics.tokens) : undefined,
      toolCallRatio: beforeMetrics && afterMetrics ? ratio(afterMetrics.tools, beforeMetrics.tools) : undefined,
    };
  });

  return {
    baselineRunId: baseline.runId,
    currentRunId: current.runId,
    compatibleCaseSet: baseline.caseSetHash === current.caseSetHash,
    addedCases: allIds.filter(id => !baselineMap.has(id)),
    removedCases: allIds.filter(id => !currentMap.has(id)),
    regressions: diffs.filter(diff => statusRank(diff.currentStatus) < statusRank(diff.baselineStatus)),
    improvements: diffs.filter(diff => statusRank(diff.currentStatus) > statusRank(diff.baselineStatus)),
    diffs,
  };
}

export function scenarioComparisonMarkdown(comparison: ScenarioRunComparison): string {
  const lines = [
    '# 场景回归差异报告',
    '',
    `- Baseline：${comparison.baselineRunId}`,
    `- Current：${comparison.currentRunId}`,
    `- Case set：${comparison.compatibleCaseSet ? '一致' : '不一致'}`,
    `- 新增 case：${comparison.addedCases.length}`,
    `- 移除 case：${comparison.removedCases.length}`,
    `- 回归：${comparison.regressions.length}`,
    `- 改善：${comparison.improvements.length}`,
    '',
    '| Case | 场景 | Baseline | Current | 通过率变化 | Judge 变化 | 耗时倍率 | Token 倍率 | 工具倍率 |',
    '|---|---|---|---|---:|---:|---:|---:|---:|',
    ...comparison.diffs.map(diff => `| ${diff.caseId} | ${diff.scenario} | ${diff.baselineStatus ?? '—'} | ${diff.currentStatus ?? '—'} | ${diff.passRateDelta?.toFixed(3) ?? '—'} | ${diff.judgeScoreDelta?.toFixed(3) ?? '—'} | ${diff.durationRatio?.toFixed(2) ?? '—'} | ${diff.tokenRatio?.toFixed(2) ?? '—'} | ${diff.toolCallRatio?.toFixed(2) ?? '—'} |`),
    '',
  ];
  return lines.join('\n');
}
