import type { CanaryCase, ContractCase, LiveSafetyLevel } from './live-types.js';
import { referencedEnvironmentVariables } from './live-interpolation.js';

const READ_ONLY_TOOLS = new Set([
  'search_knowledge',
  'read_knowledge_document',
  'list_knowledge_recent',
  'calculate_date',
  'query_clients',
  'list_customers',
  'trade_summary',
  'query_normal_trading_summary',
  'analyze_sbl_usage',
  'mcp_logyi_logyi_search_sheets',
]);

const SANDBOX_TOOLS = new Set([
  'sandbox_exec',
  'sandbox_read_file',
  'sandbox_list',
  'markdown_to_image',
  'export_north_info_csv',
]);

const DELIVERY_TOOLS = new Set([
  'send_image',
  'send_file',
]);

const SAFETY_ORDER: Record<LiveSafetyLevel, number> = {
  read_only: 0,
  sandbox: 1,
  controlled_delivery: 2,
};

function requiredSafety(tool: string): LiveSafetyLevel | undefined {
  if (READ_ONLY_TOOLS.has(tool)) return 'read_only';
  if (SANDBOX_TOOLS.has(tool)) return 'sandbox';
  if (DELIVERY_TOOLS.has(tool)) return 'controlled_delivery';
  return undefined;
}

export function validateLiveToolSafety(
  safety: LiveSafetyLevel,
  tools: string[],
): string[] {
  const issues: string[] = [];
  for (const tool of tools) {
    const required = requiredSafety(tool);
    if (!required) {
      issues.push(`工具 ${tool} 未登记 live 安全策略`);
      continue;
    }
    if (SAFETY_ORDER[safety] < SAFETY_ORDER[required]) {
      issues.push(`工具 ${tool} 至少需要 safety=${required}，当前为 ${safety}`);
    }
  }
  return issues;
}

function referencedCaseEnv(item: ContractCase | CanaryCase): string[] {
  const values = item.target === 'staging'
    ? item.steps.flatMap(step => [step.input, step.assertions])
    : [item.input.text, item.assertions];
  return referencedEnvironmentVariables(values);
}

export function requiredLiveEnvironment(
  item: ContractCase | CanaryCase,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const common = item.target === 'staging'
    ? [
        'EVAL_TARGET',
        'EVAL_USER_ID',
        'EVAL_AGENT_ID',
        ...(item.safety === 'controlled_delivery' ? ['EVAL_CHANNEL', 'EVAL_TARGET_ID'] : []),
      ]
    : ['EVAL_TARGET', 'ALLOW_PROD_CANARY', 'CANARY_USER_ID', 'CANARY_AGENT_ID', 'CANARY_CHANNEL', 'CANARY_TARGET_ID'];
  const delivery = item.safety === 'controlled_delivery'
    ? item.target === 'staging'
      ? envNameForFeishu('EVAL', env)
      : envNameForFeishu('CANARY', env)
    : [];
  return [...new Set([...common, ...delivery, ...(item.requiredEnv ?? []), ...referencedCaseEnv(item)])].sort();
}

function envNameForFeishu(prefix: 'EVAL' | 'CANARY', env: NodeJS.ProcessEnv): string[] {
  return env[`${prefix}_CHANNEL`] === 'feishu' ? [`${prefix}_APP_ID`] : [];
}

export interface LiveGuardResult {
  allowed: boolean;
  missingEnv: string[];
  issues: string[];
}

export function inspectContractGuard(item: ContractCase, env: NodeJS.ProcessEnv): LiveGuardResult {
  const missingEnv = requiredLiveEnvironment(item, env).filter(name => !env[name]);
  const tools = item.steps.map(step => step.tool);
  const issues = validateLiveToolSafety(item.safety, tools);
  if (env.EVAL_TARGET && env.EVAL_TARGET !== 'staging') {
    issues.push(`Contract 拒绝目标环境: ${env.EVAL_TARGET}`);
  }
  if (item.safety === 'controlled_delivery' && env.EVAL_CHANNEL === 'wework') {
    issues.push('独立 Contract CLI 无法构造企微 WebSocket 上下文，controlled delivery 请使用 feishu/telegram');
  }
  return { allowed: missingEnv.length === 0 && issues.length === 0, missingEnv, issues };
}

export function inspectCanaryGuard(item: CanaryCase, env: NodeJS.ProcessEnv): LiveGuardResult {
  const missingEnv = requiredLiveEnvironment(item, env).filter(name => !env[name]);
  const issues = validateLiveToolSafety(item.safety, item.allowedTools);
  if (env.EVAL_TARGET && env.EVAL_TARGET !== 'production') {
    issues.push(`Canary live 要求 EVAL_TARGET=production，当前为 ${env.EVAL_TARGET}`);
  }
  if (env.ALLOW_PROD_CANARY && env.ALLOW_PROD_CANARY !== '1') {
    issues.push('Canary live 要求 ALLOW_PROD_CANARY=1');
  }
  if (item.safety === 'controlled_delivery' && env.CANARY_CHANNEL === 'wework') {
    issues.push('独立 Canary CLI 无法构造企微 WebSocket 上下文，controlled delivery 请使用 feishu/telegram 或渠道内运行器');
  }
  return { allowed: missingEnv.length === 0 && issues.length === 0, missingEnv, issues };
}
