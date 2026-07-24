import type { ValidationIssue, ValidationResult } from './case-validator.js';
import type {
  CanaryCase,
  ContractCase,
  LiveInvariant,
  LiveOutputAssertions,
  LiveSafetyLevel,
  LiveToolStep,
} from './live-types.js';

const STATUSES = new Set(['draft', 'approved', 'quarantined', 'deprecated']);
const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const SAFETY_LEVELS = new Set(['read_only', 'sandbox', 'controlled_delivery']);
const VALUE_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);
const INVARIANT_OPS = new Set(['gte', 'lte', 'eq', 'approx_ratio', 'date_order']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function pushIf(issues: ValidationIssue[], condition: boolean, path: string, message: string): void {
  if (condition) issues.push({ path, message });
}

function validateCommon(value: Record<string, unknown>, issues: ValidationIssue[]): void {
  pushIf(issues, !positiveInteger(value.version), 'version', '必须是正整数');
  pushIf(issues, !nonEmptyString(value.id), 'id', '必须是非空字符串');
  pushIf(issues, !nonEmptyString(value.title), 'title', '必须是非空字符串');
  pushIf(issues, !STATUSES.has(String(value.status)), 'status', '不支持的状态');
  pushIf(issues, !RISKS.has(String(value.risk)), 'risk', '不支持的风险等级');
  pushIf(issues, !SAFETY_LEVELS.has(String(value.safety)), 'safety', '不支持的安全等级');
  pushIf(issues, !Array.isArray(value.tags) || value.tags.some(tag => !nonEmptyString(tag)), 'tags', '必须是非空字符串数组');
  if (value.requiredEnv !== undefined) {
    pushIf(
      issues,
      !Array.isArray(value.requiredEnv) || value.requiredEnv.some(item => !/^[A-Z][A-Z0-9_]*$/.test(String(item))),
      'requiredEnv',
      '必须是合法环境变量名数组',
    );
  }
  if (value.status === 'approved') {
    pushIf(issues, !isRecord(value.review), 'review', 'approved case 必须有审核信息');
    if (isRecord(value.review)) {
      pushIf(issues, !nonEmptyString(value.review.reviewedBy), 'review.reviewedBy', '必须记录审核人');
      pushIf(issues, !nonEmptyString(value.review.reviewedAt), 'review.reviewedAt', '必须记录审核时间');
    }
  }
}

function validateRegex(pattern: unknown, path: string, issues: ValidationIssue[]): void {
  if (!nonEmptyString(pattern)) {
    issues.push({ path, message: '必须是非空正则字符串' });
    return;
  }
  try {
    new RegExp(pattern, 'u');
  } catch (error) {
    issues.push({ path, message: `非法正则: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function validateOperand(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: '必须是 { path } 或 { value }' });
    return;
  }
  const hasPath = nonEmptyString(value.path);
  const hasValue = Object.prototype.hasOwnProperty.call(value, 'value');
  pushIf(issues, hasPath === hasValue, path, '必须且只能提供 path 或 value');
}

function validateInvariant(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: '必须是对象' });
    return;
  }
  pushIf(issues, !INVARIANT_OPS.has(String(value.op)), `${path}.op`, '不支持的 invariant op');
  const invariant = value as unknown as LiveInvariant;
  if (['gte', 'lte', 'eq'].includes(String(value.op))) {
    validateOperand((invariant as any).left, `${path}.left`, issues);
    validateOperand((invariant as any).right, `${path}.right`, issues);
  } else if (value.op === 'approx_ratio') {
    validateOperand((invariant as any).result, `${path}.result`, issues);
    validateOperand((invariant as any).numerator, `${path}.numerator`, issues);
    validateOperand((invariant as any).denominator, `${path}.denominator`, issues);
    if (value.tolerance !== undefined) {
      pushIf(issues, typeof value.tolerance !== 'number' || value.tolerance < 0, `${path}.tolerance`, '必须是非负数');
    }
  } else if (value.op === 'date_order') {
    validateOperand((invariant as any).start, `${path}.start`, issues);
    validateOperand((invariant as any).end, `${path}.end`, issues);
  }
}

function validateOutputAssertions(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path, message: '必须是对象' });
    return;
  }
  const assertions = value as unknown as LiveOutputAssertions;
  if (assertions.expectSuccess !== undefined) {
    pushIf(issues, typeof assertions.expectSuccess !== 'boolean', `${path}.expectSuccess`, '必须是布尔值');
  }
  for (const field of ['requiredPaths', 'forbiddenText'] as const) {
    const list = assertions[field];
    if (list !== undefined) {
      pushIf(issues, !Array.isArray(list) || list.some(item => !nonEmptyString(item)), `${path}.${field}`, '必须是非空字符串数组');
    }
  }
  if (assertions.types !== undefined) {
    if (!Array.isArray(assertions.types)) issues.push({ path: `${path}.types`, message: '必须是数组' });
    else assertions.types.forEach((item, index) => {
      const itemPath = `${path}.types[${index}]`;
      pushIf(issues, !isRecord(item), itemPath, '必须是对象');
      if (isRecord(item)) {
        pushIf(issues, !nonEmptyString(item.path), `${itemPath}.path`, '必须是非空字符串');
        pushIf(issues, !VALUE_TYPES.has(String(item.type)), `${itemPath}.type`, '不支持的类型');
      }
    });
  }
  for (const field of ['equals', 'contains'] as const) {
    const list = assertions[field];
    if (list !== undefined) {
      if (!Array.isArray(list)) issues.push({ path: `${path}.${field}`, message: '必须是数组' });
      else list.forEach((item, index) => {
        const itemPath = `${path}.${field}[${index}]`;
        pushIf(issues, !isRecord(item), itemPath, '必须是对象');
        if (isRecord(item)) {
          pushIf(issues, !nonEmptyString(item.path), `${itemPath}.path`, '必须是非空字符串');
          pushIf(issues, !Object.prototype.hasOwnProperty.call(item, 'value'), `${itemPath}.value`, '必须提供 value');
        }
      });
    }
  }
  if (assertions.matches !== undefined) {
    if (!Array.isArray(assertions.matches)) issues.push({ path: `${path}.matches`, message: '必须是数组' });
    else assertions.matches.forEach((item, index) => {
      const itemPath = `${path}.matches[${index}]`;
      pushIf(issues, !isRecord(item), itemPath, '必须是对象');
      if (isRecord(item)) {
        pushIf(issues, !nonEmptyString(item.path), `${itemPath}.path`, '必须是非空字符串');
        validateRegex(item.pattern, `${itemPath}.pattern`, issues);
      }
    });
  }
  if (assertions.invariants !== undefined) {
    if (!Array.isArray(assertions.invariants)) issues.push({ path: `${path}.invariants`, message: '必须是数组' });
    else assertions.invariants.forEach((item, index) => validateInvariant(item, `${path}.invariants[${index}]`, issues));
  }
  if (assertions.maxDurationMs !== undefined) {
    pushIf(issues, !positiveInteger(assertions.maxDurationMs), `${path}.maxDurationMs`, '必须是正整数');
  }
}

function validateStep(value: unknown, index: number, issues: ValidationIssue[]): void {
  const path = `steps[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: '必须是对象' });
    return;
  }
  pushIf(issues, !/^[a-z][a-z0-9_-]*$/.test(String(value.id)), `${path}.id`, '必须是小写稳定标识');
  pushIf(issues, !nonEmptyString(value.tool), `${path}.tool`, '必须是非空字符串');
  pushIf(issues, !isRecord(value.input), `${path}.input`, '必须是对象');
  validateOutputAssertions(value.assertions, `${path}.assertions`, issues);
}

export function validateContractCase(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { valid: false, issues: [{ path: '$', message: 'contract case 必须是对象' }] };
  validateCommon(value, issues);
  pushIf(issues, value.target !== 'staging', 'target', 'Contract 只能以 staging 为目标');
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    issues.push({ path: 'steps', message: '至少需要一个工具步骤' });
  } else {
    const seen = new Set<string>();
    value.steps.forEach((step, index) => {
      validateStep(step, index, issues);
      if (isRecord(step) && nonEmptyString(step.id)) {
        pushIf(issues, seen.has(step.id), `steps[${index}].id`, '步骤 id 不能重复');
        seen.add(step.id);
      }
    });
  }
  if (!isRecord(value.execution)) issues.push({ path: 'execution', message: '必须是对象' });
  else pushIf(issues, !positiveInteger(value.execution.timeoutMs), 'execution.timeoutMs', '必须是正整数');
  return { valid: issues.length === 0, issues };
}

export function validateCanaryCase(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { valid: false, issues: [{ path: '$', message: 'canary case 必须是对象' }] };
  validateCommon(value, issues);
  pushIf(issues, value.target !== 'production', 'target', 'Canary 只能以 production 为目标');
  if (!isRecord(value.input)) issues.push({ path: 'input', message: '必须是对象' });
  else pushIf(issues, !nonEmptyString(value.input.text), 'input.text', '必须是非空字符串');
  pushIf(
    issues,
    !Array.isArray(value.allowedTools) || value.allowedTools.length === 0 || value.allowedTools.some(item => !nonEmptyString(item)),
    'allowedTools',
    '至少需要一个允许工具',
  );
  if (!isRecord(value.assertions)) issues.push({ path: 'assertions', message: '必须是对象' });
  else {
    const assertions = value.assertions;
    for (const field of ['forbiddenTools', 'allowedTools', 'toolOrder', 'requiredFacts', 'forbiddenClaims'] as const) {
      const list = assertions[field];
      if (list !== undefined) {
        pushIf(
          issues,
          !Array.isArray(list) || list.some(item => !nonEmptyString(item)),
          `assertions.${field}`,
          '必须是非空字符串数组',
        );
      }
    }
    if (assertions.answerRegex !== undefined) {
      if (!Array.isArray(assertions.answerRegex)) {
        issues.push({ path: 'assertions.answerRegex', message: '必须是正则字符串数组' });
      } else {
        assertions.answerRegex.forEach((pattern, index) => validateRegex(pattern, `assertions.answerRegex[${index}]`, issues));
      }
    }
    if (assertions.requiredTools !== undefined) {
      if (!Array.isArray(assertions.requiredTools)) {
        issues.push({ path: 'assertions.requiredTools', message: '必须是数组' });
      } else {
        assertions.requiredTools.forEach((item, index) => {
          const itemPath = `assertions.requiredTools[${index}]`;
          if (!isRecord(item)) {
            issues.push({ path: itemPath, message: '必须是对象' });
            return;
          }
          pushIf(issues, !nonEmptyString(item.tool), `${itemPath}.tool`, '必须是非空字符串');
          if (item.minCalls !== undefined) pushIf(issues, !positiveInteger(item.minCalls), `${itemPath}.minCalls`, '必须是正整数');
          if (item.maxCalls !== undefined) pushIf(issues, !positiveInteger(item.maxCalls), `${itemPath}.maxCalls`, '必须是正整数');
          if (typeof item.minCalls === 'number' && typeof item.maxCalls === 'number') {
            pushIf(issues, item.maxCalls < item.minCalls, `${itemPath}.maxCalls`, '不能小于 minCalls');
          }
        });
      }
    }
    for (const field of ['maxToolCalls', 'maxLoopRounds'] as const) {
      if (assertions[field] !== undefined) {
        pushIf(issues, !positiveInteger(assertions[field]), `assertions.${field}`, '必须是正整数');
      }
    }
    const allowed = Array.isArray(value.allowedTools) ? new Set(value.allowedTools) : new Set();
    for (const tool of [
      ...(Array.isArray(assertions.allowedTools) ? assertions.allowedTools : []),
      ...(Array.isArray(assertions.requiredTools)
        ? assertions.requiredTools.filter(isRecord).map(item => item.tool).filter(nonEmptyString)
        : []),
    ]) {
      pushIf(issues, !allowed.has(tool), 'assertions', `断言工具 ${tool} 不在 case allowedTools 中`);
    }
  }
  if (!isRecord(value.execution)) issues.push({ path: 'execution', message: '必须是对象' });
  else {
    pushIf(issues, !positiveInteger(value.execution.repetitions), 'execution.repetitions', '必须是正整数');
    pushIf(issues, typeof value.execution.repetitions === 'number' && value.execution.repetitions > 3, 'execution.repetitions', 'production Canary 最多重复 3 次');
    pushIf(issues, !positiveInteger(value.execution.timeoutMs), 'execution.timeoutMs', '必须是正整数');
  }
  return { valid: issues.length === 0, issues };
}

function invalidMessage(kind: string, result: ValidationResult): string {
  return `${kind} 校验失败: ${result.issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`;
}

export function asContractCase(value: unknown): ContractCase {
  const result = validateContractCase(value);
  if (!result.valid) throw new Error(invalidMessage('Contract case', result));
  return value as ContractCase;
}

export function asCanaryCase(value: unknown): CanaryCase {
  const result = validateCanaryCase(value);
  if (!result.valid) throw new Error(invalidMessage('Canary case', result));
  return value as CanaryCase;
}
