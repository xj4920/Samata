import type {
  ScenarioCase,
  ScenarioTaxonomy,
  ToolFixture,
  ToolInputMatcher,
} from './types.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const CASE_STATUSES = new Set(['draft', 'approved', 'quarantined', 'deprecated']);
const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const MODES = new Set(['self-test', 'frozen', 'live']);
const MATCH_MODES = new Set(['any', 'exact', 'subset', 'contains']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function pushIf(
  issues: ValidationIssue[],
  condition: boolean,
  path: string,
  message: string,
): void {
  if (condition) issues.push({ path, message });
}

function validateMatcher(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: '必须是对象' });
    return;
  }
  pushIf(issues, !MATCH_MODES.has(String(value.mode)), `${path}.mode`, '不支持的 matcher mode');
  pushIf(
    issues,
    value.mode !== 'any' && value.value === undefined,
    `${path}.value`,
    '非 any matcher 必须提供 value',
  );
}

function validateFixture(fixture: unknown, index: number, issues: ValidationIssue[]): void {
  const path = `fixtures[${index}]`;
  if (!isRecord(fixture)) {
    issues.push({ path, message: '必须是对象' });
    return;
  }
  pushIf(issues, !nonEmptyString(fixture.tool), `${path}.tool`, '必须是非空字符串');
  if (!Array.isArray(fixture.responses) || fixture.responses.length === 0) {
    issues.push({ path: `${path}.responses`, message: '至少需要一个响应' });
    return;
  }
  fixture.responses.forEach((response, responseIndex) => {
    const responsePath = `${path}.responses[${responseIndex}]`;
    if (!isRecord(response)) {
      issues.push({ path: responsePath, message: '必须是对象' });
      return;
    }
    pushIf(issues, !('output' in response), `${responsePath}.output`, '必须显式提供 output');
    if (response.input !== undefined) validateMatcher(response.input, `${responsePath}.input`, issues);
  });
}

export function validateTaxonomy(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { valid: false, issues: [{ path: '$', message: 'taxonomy 必须是对象' }] };

  pushIf(issues, !positiveInteger(value.version), 'version', '必须是正整数');
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    issues.push({ path: 'scenarios', message: '至少需要一个场景' });
  } else {
    const seen = new Set<string>();
    value.scenarios.forEach((scenario, index) => {
      const path = `scenarios[${index}]`;
      if (!isRecord(scenario)) {
        issues.push({ path, message: '必须是对象' });
        return;
      }
      pushIf(issues, !nonEmptyString(scenario.id), `${path}.id`, '必须是非空字符串');
      pushIf(issues, !nonEmptyString(scenario.name), `${path}.name`, '必须是非空字符串');
      pushIf(issues, !nonEmptyString(scenario.description), `${path}.description`, '必须是非空字符串');
      if (nonEmptyString(scenario.id)) {
        pushIf(issues, seen.has(scenario.id), `${path}.id`, `重复场景 id: ${scenario.id}`);
        seen.add(scenario.id);
      }
    });
  }

  return { valid: issues.length === 0, issues };
}

export function validateScenarioCase(value: unknown, taxonomy: ScenarioTaxonomy): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { valid: false, issues: [{ path: '$', message: 'case 必须是对象' }] };

  pushIf(issues, !positiveInteger(value.version), 'version', '必须是正整数');
  pushIf(issues, !nonEmptyString(value.id), 'id', '必须是非空字符串');
  pushIf(issues, !nonEmptyString(value.title), 'title', '必须是非空字符串');
  pushIf(issues, !nonEmptyString(value.scenario), 'scenario', '必须是非空字符串');
  if (nonEmptyString(value.scenario)) {
    pushIf(
      issues,
      !taxonomy.scenarios.some(item => item.id === value.scenario),
      'scenario',
      `taxonomy 中不存在场景: ${value.scenario}`,
    );
  }
  pushIf(issues, !CASE_STATUSES.has(String(value.status)), 'status', '不支持的 case 状态');
  pushIf(issues, !RISKS.has(String(value.risk)), 'risk', '不支持的风险等级');
  pushIf(issues, !positiveInteger(value.priority), 'priority', '必须是正整数');
  pushIf(issues, !Array.isArray(value.tags), 'tags', '必须是字符串数组');
  if (Array.isArray(value.tags)) {
    pushIf(issues, value.tags.some(tag => !nonEmptyString(tag)), 'tags', '不能包含空标签');
  }

  if (!isRecord(value.input)) {
    issues.push({ path: 'input', message: '必须是对象' });
  } else {
    pushIf(issues, !nonEmptyString(value.input.text), 'input.text', '必须是非空字符串');
    pushIf(issues, !nonEmptyString(value.input.agent), 'input.agent', '必须是非空字符串');
    pushIf(issues, !nonEmptyString(value.input.role), 'input.role', '必须是非空字符串');
    pushIf(issues, !nonEmptyString(value.input.channel), 'input.channel', '必须是非空字符串');
    if (value.input.history !== undefined) {
      pushIf(issues, !Array.isArray(value.input.history), 'input.history', '必须是数组');
    }
  }

  if (!Array.isArray(value.fixtures)) {
    issues.push({ path: 'fixtures', message: '必须是数组' });
  } else {
    const fixtureTools = new Set<string>();
    value.fixtures.forEach((fixture, index) => {
      validateFixture(fixture, index, issues);
      if (isRecord(fixture) && nonEmptyString(fixture.tool)) {
        pushIf(issues, fixtureTools.has(fixture.tool), `fixtures[${index}].tool`, '同一工具只能定义一个 fixture');
        fixtureTools.add(fixture.tool);
      }
    });
  }

  if (!isRecord(value.assertions)) {
    issues.push({ path: 'assertions', message: '必须是对象' });
  } else {
    const toolInputs = value.assertions.toolInputs;
    if (toolInputs !== undefined) {
      if (!Array.isArray(toolInputs)) {
        issues.push({ path: 'assertions.toolInputs', message: '必须是数组' });
      } else {
        toolInputs.forEach((assertion, index) => {
          if (!isRecord(assertion)) {
            issues.push({ path: `assertions.toolInputs[${index}]`, message: '必须是对象' });
            return;
          }
          validateMatcher(assertion.input, `assertions.toolInputs[${index}].input`, issues);
        });
      }
    }
  }

  if (!isRecord(value.judge)) {
    issues.push({ path: 'judge', message: '必须是对象' });
  } else {
    pushIf(issues, typeof value.judge.enabled !== 'boolean', 'judge.enabled', '必须是布尔值');
    if (value.judge.enabled === true) {
      pushIf(
        issues,
        !Array.isArray(value.judge.criteria) || value.judge.criteria.length === 0,
        'judge.criteria',
        '启用 judge 时至少需要一个评分标准',
      );
      pushIf(
        issues,
        typeof value.judge.minScore !== 'number' || value.judge.minScore < 0 || value.judge.minScore > 1,
        'judge.minScore',
        '启用 judge 时 minScore 必须在 0 到 1 之间',
      );
    }
  }

  if (!isRecord(value.execution)) {
    issues.push({ path: 'execution', message: '必须是对象' });
  } else {
    pushIf(issues, !MODES.has(String(value.execution.mode)), 'execution.mode', '不支持的运行模式');
    pushIf(issues, !positiveInteger(value.execution.repetitions), 'execution.repetitions', '必须是正整数');
    pushIf(issues, !positiveInteger(value.execution.timeoutMs), 'execution.timeoutMs', '必须是正整数');
  }

  if (value.status === 'approved') {
    const review = value.review;
    pushIf(issues, !isRecord(review), 'review', 'approved case 必须有审核信息');
    if (isRecord(review)) {
      pushIf(issues, !nonEmptyString(review.reviewedBy), 'review.reviewedBy', 'approved case 必须记录审核人');
      pushIf(issues, !nonEmptyString(review.reviewedAt), 'review.reviewedAt', 'approved case 必须记录审核时间');
    }
  }

  return { valid: issues.length === 0, issues };
}

export function fixtureToolNames(fixtures: ToolFixture[]): Set<string> {
  return new Set(fixtures.map(fixture => fixture.tool));
}

export function isToolInputMatcher(value: unknown): value is ToolInputMatcher {
  if (!isRecord(value) || !MATCH_MODES.has(String(value.mode))) return false;
  return value.mode === 'any' || value.value !== undefined;
}

export function asScenarioCase(value: unknown, taxonomy: ScenarioTaxonomy): ScenarioCase {
  const result = validateScenarioCase(value, taxonomy);
  if (!result.valid) {
    const detail = result.issues.map(issue => `${issue.path}: ${issue.message}`).join('; ');
    throw new Error(`场景 case 校验失败: ${detail}`);
  }
  return value as ScenarioCase;
}
