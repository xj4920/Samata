import { createHash } from 'node:crypto';
import { redactText } from './redaction.js';
import { interpolateLiveValue } from './live-interpolation.js';
import { evaluateCanaryAssertions } from './live-assertions.js';
import type {
  CanaryCase,
  CanaryCaseResult,
  CanaryExecutionResult,
  CanaryRepetitionResult,
} from './live-types.js';

export type CanaryExecutor = (
  item: CanaryCase,
  repetition: number,
  prompt: string,
  abortSignal?: AbortSignal,
) => Promise<CanaryExecutionResult>;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function timeout<T>(factory: (abortSignal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Canary 执行超过 ${timeoutMs}ms`));
      reject(new Error(`Canary 执行超过 ${timeoutMs}ms`));
    }, timeoutMs);
    let promise: Promise<T>;
    try {
      promise = factory(controller.signal);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
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

export async function runCanaryCase(
  item: CanaryCase,
  executor: CanaryExecutor,
  env: NodeJS.ProcessEnv,
): Promise<CanaryCaseResult> {
  const prompt = interpolateLiveValue(item.input.text, { env, strict: true }) as string;
  const assertions = interpolateLiveValue(item.assertions, { env, strict: true }) as CanaryCase['assertions'];
  const repetitions: CanaryRepetitionResult[] = [];

  for (let repetition = 1; repetition <= item.execution.repetitions; repetition++) {
    try {
      const execution = await timeout(
        abortSignal => executor(item, repetition, prompt, abortSignal),
        item.execution.timeoutMs,
      );
      const checks = evaluateCanaryAssertions(assertions, execution);
      const answer = redactText(execution.answer);
      repetitions.push({
        repetition,
        status: checks.every(check => check.passed) ? 'passed' : 'failed',
        durationMs: execution.durationMs,
        loopRounds: execution.loopRounds,
        toolCalls: execution.toolCalls.length,
        answerHash: digest(answer),
        answerPreview: answer ? `[redacted answer chars=${answer.length}]` : '',
        toolTrace: execution.toolCalls.map(call => ({
          tool: call.tool,
          success: call.success,
          durationMs: call.durationMs,
          inputHash: digest(JSON.stringify(redactText(JSON.stringify(call.input)))),
          outputHash: digest(redactText(call.output)),
        })),
        assertions: checks.map(check => ({ id: check.id, passed: check.passed, message: check.message })),
        error: execution.error,
      });
    } catch (error) {
      repetitions.push({
        repetition,
        status: 'error',
        durationMs: 0,
        loopRounds: 0,
        toolCalls: 0,
        answerHash: digest(''),
        answerPreview: '',
        toolTrace: [],
        assertions: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const passed = repetitions.filter(item => item.status === 'passed').length;
  const status = repetitions.some(rep => rep.status === 'error')
    ? 'error'
    : repetitions.some(rep => rep.status === 'failed')
      ? 'failed'
      : 'passed';
  return {
    caseId: item.id,
    risk: item.risk,
    status,
    passRate: repetitions.length > 0 ? passed / repetitions.length : 0,
    repetitions,
  };
}

export async function runCanaryCases(
  cases: CanaryCase[],
  executor: CanaryExecutor,
  env: NodeJS.ProcessEnv,
): Promise<CanaryCaseResult[]> {
  const results: CanaryCaseResult[] = [];
  for (const item of cases) results.push(await runCanaryCase(item, executor, env));
  return results;
}
