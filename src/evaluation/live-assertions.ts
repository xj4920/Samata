import type { AssertionResult, CapturedToolCall, ScenarioAssertions } from './types.js';
import type { LiveInvariant, LiveOperand, LiveOutputAssertions, LiveToolExecution } from './live-types.js';
import { matchesToolInput } from './matcher.js';
import { containsLiveValue, getLivePath, liveValueType, liveValuesEqual } from './live-value.js';

function result(
  id: string,
  passed: boolean,
  message: string,
  expected?: unknown,
  actual?: unknown,
): AssertionResult {
  return { id, passed, message, expected, actual };
}

function operand(value: unknown, item: LiveOperand): unknown {
  return 'path' in item ? getLivePath(value, item.path) : item.value;
}

function invariantResult(value: unknown, item: LiveInvariant, index: number): AssertionResult {
  const id = `invariant:${index}:${item.op}`;
  if (item.op === 'gte' || item.op === 'lte' || item.op === 'eq') {
    const left = operand(value, item.left);
    const right = operand(value, item.right);
    const passed = item.op === 'eq'
      ? liveValuesEqual(left, right)
      : typeof left === 'number' && typeof right === 'number'
        ? item.op === 'gte' ? left >= right : left <= right
        : false;
    return result(id, passed, `输出必须满足 ${item.op}`, item, { left, right });
  }
  if (item.op === 'approx_ratio') {
    const actual = operand(value, item.result);
    const numerator = operand(value, item.numerator);
    const denominator = operand(value, item.denominator);
    const tolerance = item.tolerance ?? 0.001;
    const expected = typeof numerator === 'number' && typeof denominator === 'number' && denominator !== 0
      ? numerator / denominator
      : Number.NaN;
    const passed = typeof actual === 'number' && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
    return result(id, passed, '输出比率必须满足 numerator / denominator', expected, actual);
  }
  if (item.op !== 'date_order') {
    return result(id, false, `不支持的 invariant: ${(item as LiveInvariant).op}`);
  }
  const start = operand(value, item.start);
  const end = operand(value, item.end);
  const startTime = typeof start === 'string' ? Date.parse(start) : Number.NaN;
  const endTime = typeof end === 'string' ? Date.parse(end) : Number.NaN;
  return result(id, Number.isFinite(startTime) && Number.isFinite(endTime) && startTime <= endTime, '起始日期不能晚于结束日期', start, end);
}

export function evaluateLiveOutputAssertions(
  assertions: LiveOutputAssertions,
  execution: LiveToolExecution,
): AssertionResult[] {
  const output = execution.parsedOutput;
  const checks: AssertionResult[] = [];
  const expectedSuccess = assertions.expectSuccess ?? true;
  checks.push(result('tool-success', execution.success === expectedSuccess, '工具成功状态必须符合预期', expectedSuccess, execution.success));

  for (const path of assertions.requiredPaths ?? []) {
    const actual = getLivePath(output, path);
    checks.push(result(`required-path:${path}`, actual !== undefined, `输出必须包含路径: ${path}`, path, actual));
  }
  for (const item of assertions.types ?? []) {
    const actual = getLivePath(output, item.path);
    checks.push(result(`type:${item.path}`, liveValueType(actual) === item.type, `${item.path} 类型必须为 ${item.type}`, item.type, liveValueType(actual)));
  }
  for (const item of assertions.equals ?? []) {
    const actual = getLivePath(output, item.path);
    checks.push(result(`equals:${item.path}`, liveValuesEqual(actual, item.value), `${item.path} 必须等于预期值`, item.value, actual));
  }
  for (const item of assertions.contains ?? []) {
    const actual = getLivePath(output, item.path);
    checks.push(result(`contains:${item.path}`, containsLiveValue(actual, item.value), `${item.path} 必须包含预期值`, item.value, actual));
  }
  for (const item of assertions.matches ?? []) {
    const actual = getLivePath(output, item.path);
    const passed = typeof actual === 'string' && new RegExp(item.pattern, 'u').test(actual);
    checks.push(result(`matches:${item.path}`, passed, `${item.path} 必须匹配正则`, item.pattern, actual));
  }
  const serialized = typeof output === 'string' ? output : JSON.stringify(output);
  for (const forbidden of assertions.forbiddenText ?? []) {
    checks.push(result(`forbidden-text:${forbidden}`, !serialized.includes(forbidden), `输出不得包含: ${forbidden}`, forbidden));
  }
  (assertions.invariants ?? []).forEach((item, index) => checks.push(invariantResult(output, item, index)));
  if (assertions.maxDurationMs !== undefined) {
    checks.push(result(
      'max-duration-ms',
      execution.durationMs <= assertions.maxDurationMs,
      '工具耗时不能超限',
      assertions.maxDurationMs,
      execution.durationMs,
    ));
  }
  return checks;
}

function toolCallsByName(calls: CapturedToolCall[], tool: string): CapturedToolCall[] {
  return calls.filter(call => call.tool === tool);
}

function isSubsequence(expected: string[], actual: string[]): boolean {
  let cursor = 0;
  for (const item of actual) {
    if (item === expected[cursor]) cursor++;
    if (cursor === expected.length) return true;
  }
  return expected.length === 0;
}

export function evaluateCanaryAssertions(
  assertions: ScenarioAssertions,
  execution: { answer: string; toolCalls: CapturedToolCall[]; loopRounds: number },
): AssertionResult[] {
  const answer = execution.answer.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const tools = execution.toolCalls.map(call => call.tool);
  const checks: AssertionResult[] = [];

  for (const required of assertions.requiredTools ?? []) {
    const count = toolCallsByName(execution.toolCalls, required.tool).length;
    const min = required.minCalls ?? 1;
    checks.push(result(`required-tool:${required.tool}:min`, count >= min, `${required.tool} 至少调用 ${min} 次`, min, count));
    if (required.maxCalls !== undefined) {
      checks.push(result(`required-tool:${required.tool}:max`, count <= required.maxCalls, `${required.tool} 最多调用 ${required.maxCalls} 次`, required.maxCalls, count));
    }
  }
  for (const forbidden of assertions.forbiddenTools ?? []) {
    const count = toolCallsByName(execution.toolCalls, forbidden).length;
    checks.push(result(`forbidden-tool:${forbidden}`, count === 0, `不得调用 ${forbidden}`, 0, count));
  }
  if (assertions.allowedTools) {
    const allowed = new Set(assertions.allowedTools);
    const unexpected = [...new Set(tools.filter(tool => !allowed.has(tool)))];
    checks.push(result('allowed-tools', unexpected.length === 0, '所有工具调用必须在 allowlist 中', assertions.allowedTools, unexpected));
  }
  if (assertions.toolOrder) {
    checks.push(result('tool-order', isSubsequence(assertions.toolOrder, tools), '必须按要求的相对顺序调用工具', assertions.toolOrder, tools));
  }
  for (const inputRule of assertions.toolInputs ?? []) {
    const callIndex = (inputRule.call ?? 1) - 1;
    const call = toolCallsByName(execution.toolCalls, inputRule.tool)[callIndex];
    checks.push(result(
      `tool-input:${inputRule.tool}:${callIndex + 1}`,
      !!call && matchesToolInput(inputRule.input, call.input),
      `${inputRule.tool} 第 ${callIndex + 1} 次调用参数必须匹配`,
      inputRule.input,
      call?.input,
    ));
  }
  for (const fact of assertions.requiredFacts ?? []) {
    checks.push(result(`required-fact:${fact}`, answer.includes(fact.normalize('NFKC').toLowerCase()), `回答必须包含事实: ${fact}`, fact));
  }
  for (const claim of assertions.forbiddenClaims ?? []) {
    checks.push(result(`forbidden-claim:${claim}`, !answer.includes(claim.normalize('NFKC').toLowerCase()), `回答不得声称: ${claim}`, claim));
  }
  for (const pattern of assertions.answerRegex ?? []) {
    checks.push(result(`answer-regex:${pattern}`, new RegExp(pattern, 'iu').test(execution.answer), `回答必须匹配正则: ${pattern}`, pattern));
  }
  if (assertions.maxToolCalls !== undefined) {
    checks.push(result('max-tool-calls', execution.toolCalls.length <= assertions.maxToolCalls, '工具调用数不能超限', assertions.maxToolCalls, execution.toolCalls.length));
  }
  if (assertions.maxLoopRounds !== undefined) {
    checks.push(result('max-loop-rounds', execution.loopRounds <= assertions.maxLoopRounds, 'Agent loop 轮数不能超限', assertions.maxLoopRounds, execution.loopRounds));
  }
  if (assertions.maxInputTokens !== undefined || assertions.maxOutputTokens !== undefined) {
    checks.push(result('unsupported-token-budget', false, 'Live Canary 当前无法从 Agent API 获取 token 指标，请移除 token 预算断言'));
  }
  return checks;
}
