import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';
import { compareScenarioRuns } from './compare.js';
import type { ScenarioCaseRunResult, ScenarioRunManifest } from './types.js';

interface GateThreshold {
  hardAssertionPassRate: number;
  repetitionPassRate: number;
  judgeScoreTolerance?: number;
}

export interface ScenarioGateConfig {
  version: number;
  critical: GateThreshold;
  default: GateThreshold;
  metrics?: {
    durationRegressionWarningRatio?: number;
    tokenRegressionWarningRatio?: number;
    toolCallRegressionWarningRatio?: number;
  };
}

export interface ScenarioGateResult {
  passed: boolean;
  failures: string[];
  warnings: string[];
}

export function loadScenarioGateConfig(
  path = resolve(process.cwd(), 'evals/gates.yaml'),
): ScenarioGateConfig {
  const value = parse(readFileSync(path, 'utf8')) as ScenarioGateConfig;
  if (!value || value.version !== 1 || !value.critical || !value.default) {
    throw new Error('无效的场景 gate 配置');
  }
  return value;
}

function hardAssertionPassRate(result: ScenarioCaseRunResult): number {
  if (result.repetitions.length === 0) return 0;
  const passed = result.repetitions.filter(repetition =>
    repetition.assertions.every(assertion => assertion.passed),
  ).length;
  return passed / result.repetitions.length;
}

export function evaluateScenarioGate(
  current: ScenarioRunManifest,
  config: ScenarioGateConfig,
  baseline?: ScenarioRunManifest,
): ScenarioGateResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const result of current.cases) {
    const threshold = result.risk === 'critical' ? config.critical : config.default;
    const hardRate = hardAssertionPassRate(result);
    if (hardRate < threshold.hardAssertionPassRate) {
      failures.push(`${result.caseId}: 硬断言通过率 ${hardRate.toFixed(3)} < ${threshold.hardAssertionPassRate}`);
    }
    if (result.passRate < threshold.repetitionPassRate) {
      failures.push(`${result.caseId}: 重复通过率 ${result.passRate.toFixed(3)} < ${threshold.repetitionPassRate}`);
    }
    if (result.status === 'error') failures.push(`${result.caseId}: 执行错误`);
    if (result.status === 'inconclusive') failures.push(`${result.caseId}: 结果不确定`);
  }

  if (baseline) {
    const comparison = compareScenarioRuns(baseline, current);
    for (const removed of comparison.removedCases) failures.push(`${removed}: 当前运行缺少 baseline case`);
    for (const regression of comparison.regressions) {
      failures.push(`${regression.caseId}: 状态从 ${regression.baselineStatus} 退化为 ${regression.currentStatus}`);
    }
    for (const diff of comparison.diffs) {
      const currentCase = current.cases.find(item => item.caseId === diff.caseId);
      const tolerance = currentCase?.risk === 'critical'
        ? config.critical.judgeScoreTolerance ?? 0
        : config.default.judgeScoreTolerance ?? 0;
      if (diff.judgeScoreDelta !== undefined && diff.judgeScoreDelta < -tolerance) {
        failures.push(`${diff.caseId}: Judge 分数下降 ${Math.abs(diff.judgeScoreDelta).toFixed(3)}，超过容差 ${tolerance}`);
      }
      const metricRules: Array<[number | undefined, number | undefined, string]> = [
        [diff.durationRatio, config.metrics?.durationRegressionWarningRatio, '耗时'],
        [diff.tokenRatio, config.metrics?.tokenRegressionWarningRatio, 'Token'],
        [diff.toolCallRatio, config.metrics?.toolCallRegressionWarningRatio, '工具调用'],
      ];
      for (const [ratio, warningRatio, label] of metricRules) {
        if (ratio !== undefined && warningRatio !== undefined && ratio > 1 + warningRatio) {
          warnings.push(`${diff.caseId}: ${label}为 baseline 的 ${ratio.toFixed(2)} 倍`);
        }
      }
    }
  }

  return { passed: failures.length === 0, failures, warnings };
}
