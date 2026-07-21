import { matchesToolInput } from './matcher.js';
import type {
  AssertionResult,
  CapturedToolCall,
  ScenarioCase,
  ScenarioExecutionResult,
} from './types.js';

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function assertion(
  id: string,
  passed: boolean,
  message: string,
  expected?: unknown,
  actual?: unknown,
): AssertionResult {
  return { id, passed, message, expected, actual };
}

function isSubsequence(expected: string[], actual: string[]): boolean {
  let cursor = 0;
  for (const item of actual) {
    if (item === expected[cursor]) cursor++;
    if (cursor === expected.length) return true;
  }
  return expected.length === 0;
}

function toolCallsByName(calls: CapturedToolCall[], tool: string): CapturedToolCall[] {
  return calls.filter(call => call.tool === tool);
}

export function evaluateScenarioAssertions(
  scenarioCase: ScenarioCase,
  execution: ScenarioExecutionResult,
): AssertionResult[] {
  const rules = scenarioCase.assertions;
  const calls = execution.toolCalls;
  const toolNames = calls.map(call => call.tool);
  const answer = normalizeText(execution.answer);
  const results: AssertionResult[] = [];

  for (const required of rules.requiredTools ?? []) {
    const count = toolCallsByName(calls, required.tool).length;
    const min = required.minCalls ?? 1;
    results.push(assertion(
      `required-tool:${required.tool}:min`,
      count >= min,
      `${required.tool} 至少调用 ${min} 次`,
      min,
      count,
    ));
    if (required.maxCalls !== undefined) {
      results.push(assertion(
        `required-tool:${required.tool}:max`,
        count <= required.maxCalls,
        `${required.tool} 最多调用 ${required.maxCalls} 次`,
        required.maxCalls,
        count,
      ));
    }
  }

  for (const forbidden of rules.forbiddenTools ?? []) {
    const count = toolCallsByName(calls, forbidden).length;
    results.push(assertion(
      `forbidden-tool:${forbidden}`,
      count === 0,
      `不得调用 ${forbidden}`,
      0,
      count,
    ));
  }

  if (rules.allowedTools) {
    const allowed = new Set(rules.allowedTools);
    const unexpected = [...new Set(toolNames.filter(tool => !allowed.has(tool)))];
    results.push(assertion(
      'allowed-tools',
      unexpected.length === 0,
      '所有工具调用必须在 allowlist 中',
      rules.allowedTools,
      unexpected,
    ));
  }

  if (rules.toolOrder) {
    results.push(assertion(
      'tool-order',
      isSubsequence(rules.toolOrder, toolNames),
      '必须按要求的相对顺序调用工具',
      rules.toolOrder,
      toolNames,
    ));
  }

  for (const inputRule of rules.toolInputs ?? []) {
    const callIndex = (inputRule.call ?? 1) - 1;
    const call = toolCallsByName(calls, inputRule.tool)[callIndex];
    results.push(assertion(
      `tool-input:${inputRule.tool}:${callIndex + 1}`,
      !!call && matchesToolInput(inputRule.input, call.input),
      `${inputRule.tool} 第 ${callIndex + 1} 次调用参数必须匹配`,
      inputRule.input,
      call?.input,
    ));
  }

  for (const fact of rules.requiredFacts ?? []) {
    results.push(assertion(
      `required-fact:${fact}`,
      answer.includes(normalizeText(fact)),
      `回答必须包含事实: ${fact}`,
      fact,
      execution.answer,
    ));
  }

  for (const claim of rules.forbiddenClaims ?? []) {
    results.push(assertion(
      `forbidden-claim:${claim}`,
      !answer.includes(normalizeText(claim)),
      `回答不得声称: ${claim}`,
      claim,
      execution.answer,
    ));
  }

  for (const pattern of rules.answerRegex ?? []) {
    let passed = false;
    let error: string | undefined;
    try {
      passed = new RegExp(pattern, 'iu').test(execution.answer);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    results.push(assertion(
      `answer-regex:${pattern}`,
      passed,
      error ? `回答正则非法: ${error}` : `回答必须匹配正则: ${pattern}`,
      pattern,
      execution.answer,
    ));
  }

  if (rules.maxToolCalls !== undefined) {
    results.push(assertion('max-tool-calls', calls.length <= rules.maxToolCalls, '工具调用数不能超限', rules.maxToolCalls, calls.length));
  }
  if (rules.maxLoopRounds !== undefined) {
    results.push(assertion('max-loop-rounds', execution.loopRounds <= rules.maxLoopRounds, 'Agent loop 轮数不能超限', rules.maxLoopRounds, execution.loopRounds));
  }
  if (rules.maxInputTokens !== undefined) {
    results.push(assertion('max-input-tokens', execution.inputTokens <= rules.maxInputTokens, '输入 token 不能超限', rules.maxInputTokens, execution.inputTokens));
  }
  if (rules.maxOutputTokens !== undefined) {
    results.push(assertion('max-output-tokens', execution.outputTokens <= rules.maxOutputTokens, '输出 token 不能超限', rules.maxOutputTokens, execution.outputTokens));
  }

  return results;
}
