import { createHash } from 'node:crypto';
import { redactValue } from './redaction.js';
import { interpolateLiveValue } from './live-interpolation.js';
import { evaluateLiveOutputAssertions } from './live-assertions.js';
import type {
  ContractCase,
  ContractCaseResult,
  ContractStepResult,
  LiveToolExecution,
} from './live-types.js';

export type LiveToolExecutor = (
  tool: string,
  input: Record<string, unknown>,
  timeoutMs: number,
) => Promise<LiveToolExecution>;

function digest(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(serialized).digest('hex');
}

function safeSerialized(value: unknown): string {
  const redacted = redactValue(value);
  return typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
}

function structuralPreview(value: unknown, depth = 0): unknown {
  if (depth >= 3) return '[truncated]';
  if (value === null) return null;
  if (typeof value === 'string') return `[string:${value.length}]`;
  if (typeof value === 'number') return '[number]';
  if (typeof value === 'boolean') return '[boolean]';
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length, sample: value.length > 0 ? structuralPreview(value[0], depth + 1) : undefined };
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, nested]) => [key, structuralPreview(nested, depth + 1)]),
    );
  }
  return `[${typeof value}]`;
}

export async function runContractCase(
  item: ContractCase,
  executor: LiveToolExecutor,
  env: NodeJS.ProcessEnv,
): Promise<ContractCaseResult> {
  const startedAt = Date.now();
  const stepOutputs: Record<string, unknown> = {};
  const steps: ContractStepResult[] = [];

  for (const step of item.steps) {
    let resolvedInput: Record<string, unknown>;
    try {
      resolvedInput = interpolateLiveValue(step.input, { env, steps: stepOutputs, strict: true }) as Record<string, unknown>;
    } catch (error) {
      steps.push({
        id: step.id,
        tool: step.tool,
        status: 'error',
        durationMs: 0,
        inputHash: digest(step.input),
        outputHash: digest(''),
        outputPreview: '',
        assertions: [],
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }

    try {
      const execution = await executor(step.tool, resolvedInput, item.execution.timeoutMs);
      stepOutputs[step.id] = execution.parsedOutput;
      const resolvedAssertions = interpolateLiveValue(
        step.assertions ?? {},
        { env, steps: stepOutputs, strict: true },
      ) as NonNullable<typeof step.assertions>;
      const assertions = evaluateLiveOutputAssertions(resolvedAssertions, execution);
      const hardPassed = assertions.every(check => check.passed);
      const safeOutput = safeSerialized(execution.parsedOutput);
      steps.push({
        id: step.id,
        tool: step.tool,
        status: hardPassed ? 'passed' : 'failed',
        durationMs: execution.durationMs,
        inputHash: digest(safeSerialized(resolvedInput)),
        outputHash: digest(safeOutput),
        outputPreview: JSON.stringify(structuralPreview(execution.parsedOutput)).slice(0, 500),
        assertions: assertions.map(check => ({
          id: check.id,
          passed: check.passed,
          message: check.message,
        })),
        error: execution.error,
      });
      if (!hardPassed) break;
    } catch (error) {
      steps.push({
        id: step.id,
        tool: step.tool,
        status: 'error',
        durationMs: 0,
        inputHash: digest(safeSerialized(resolvedInput)),
        outputHash: digest(''),
        outputPreview: '',
        assertions: [],
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  const status = steps.some(step => step.status === 'error')
    ? 'error'
    : steps.length !== item.steps.length || steps.some(step => step.status === 'failed')
      ? 'failed'
      : 'passed';
  return {
    caseId: item.id,
    risk: item.risk,
    status,
    steps,
    durationMs: Date.now() - startedAt,
  };
}

export async function runContractCases(
  cases: ContractCase[],
  executor: LiveToolExecutor,
  env: NodeJS.ProcessEnv,
): Promise<ContractCaseResult[]> {
  const results: ContractCaseResult[] = [];
  for (const item of cases) results.push(await runContractCase(item, executor, env));
  return results;
}
