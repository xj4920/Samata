import type {
  JudgeResult,
  ScenarioCase,
  ScenarioCaseRunResult,
  ScenarioExecutionResult,
  ScenarioRepetitionResult,
  ScenarioRunStatus,
} from './types.js';
import { evaluateScenarioAssertions } from './assertions.js';

export type ScenarioExecutor = (
  scenarioCase: ScenarioCase,
  repetition: number,
) => Promise<ScenarioExecutionResult>;

export type ScenarioJudge = (
  scenarioCase: ScenarioCase,
  execution: ScenarioExecutionResult,
) => Promise<JudgeResult>;

function timeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`场景执行超过 ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function repetitionStatus(hardPassed: boolean, judge?: JudgeResult): ScenarioRunStatus {
  if (!hardPassed) return 'failed';
  if (!judge) return 'passed';
  if (judge.status === 'inconclusive') return 'inconclusive';
  return judge.status === 'passed' ? 'passed' : 'failed';
}

function caseStatus(repetitions: ScenarioRepetitionResult[]): ScenarioRunStatus {
  if (repetitions.some(item => item.status === 'error')) return 'error';
  if (repetitions.some(item => item.status === 'failed')) return 'failed';
  if (repetitions.some(item => item.status === 'inconclusive')) return 'inconclusive';
  return 'passed';
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export async function runScenarioCase(
  scenarioCase: ScenarioCase,
  executor: ScenarioExecutor,
  judge?: ScenarioJudge,
): Promise<ScenarioCaseRunResult> {
  const repetitions: ScenarioRepetitionResult[] = [];
  for (let repetition = 1; repetition <= scenarioCase.execution.repetitions; repetition++) {
    try {
      const execution = await timeout(executor(scenarioCase, repetition), scenarioCase.execution.timeoutMs);
      const assertions = evaluateScenarioAssertions(scenarioCase, execution);
      const hardPassed = assertions.every(item => item.passed);
      const judgeResult = scenarioCase.judge.enabled && judge
        ? await judge(scenarioCase, execution)
        : scenarioCase.judge.enabled
          ? { status: 'inconclusive' as const, error: 'case 启用了 judge，但运行器未配置 judge' }
          : undefined;
      repetitions.push({
        repetition,
        status: repetitionStatus(hardPassed, judgeResult),
        assertions,
        judge: judgeResult,
        metrics: {
          durationMs: execution.durationMs,
          toolCalls: execution.toolCalls.length,
          loopRounds: execution.loopRounds,
          inputTokens: execution.inputTokens,
          outputTokens: execution.outputTokens,
        },
        answer: execution.answer,
        toolTrace: execution.toolCalls,
        error: execution.error,
      });
    } catch (error) {
      repetitions.push({
        repetition,
        status: 'error',
        assertions: [],
        metrics: { durationMs: 0, toolCalls: 0, loopRounds: 0, inputTokens: 0, outputTokens: 0 },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const passed = repetitions.filter(item => item.status === 'passed').length;
  const judgeScores = repetitions
    .map(item => item.judge?.score)
    .filter((value): value is number => typeof value === 'number');
  return {
    caseId: scenarioCase.id,
    scenario: scenarioCase.scenario,
    risk: scenarioCase.risk,
    status: caseStatus(repetitions),
    repetitions,
    passRate: repetitions.length > 0 ? passed / repetitions.length : 0,
    medianJudgeScore: median(judgeScores),
  };
}

export async function runScenarioCases(
  cases: ScenarioCase[],
  executor: ScenarioExecutor,
  judge?: ScenarioJudge,
): Promise<ScenarioCaseRunResult[]> {
  const results: ScenarioCaseRunResult[] = [];
  for (const scenarioCase of cases) results.push(await runScenarioCase(scenarioCase, executor, judge));
  return results;
}
