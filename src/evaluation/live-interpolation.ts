import { getLivePath } from './live-value.js';

const ENV_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const STEP_RE = /\{\{steps\.([a-z][a-z0-9_-]*)\.([^}]+)\}\}/gi;

export interface LiveInterpolationContext {
  env: NodeJS.ProcessEnv;
  steps?: Record<string, unknown>;
  strict?: boolean;
}

export function referencedEnvironmentVariables(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      for (const match of current.matchAll(ENV_RE)) names.add(match[1]);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current === 'object' && current !== null) Object.values(current).forEach(visit);
  };
  visit(value);
  return [...names].sort();
}

function interpolateString(value: string, context: LiveInterpolationContext): unknown {
  const envWhole = value.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/);
  if (envWhole) {
    const found = context.env[envWhole[1]];
    if (found !== undefined) return found;
    if (context.strict) throw new Error(`缺少环境变量: ${envWhole[1]}`);
    return `[MISSING_ENV:${envWhole[1]}]`;
  }

  const stepWhole = value.match(/^\{\{steps\.([a-z][a-z0-9_-]*)\.([^}]+)\}\}$/i);
  if (stepWhole) {
    const step = context.steps?.[stepWhole[1]];
    const found = step === undefined ? undefined : getLivePath(step, stepWhole[2]);
    if (found !== undefined) return found;
    if (context.strict) throw new Error(`无法解析步骤引用: ${value}`);
    return `[UNRESOLVED_STEP:${stepWhole[1]}.${stepWhole[2]}]`;
  }

  const withEnv = value.replace(ENV_RE, (_match, name: string) => {
    const found = context.env[name];
    if (found !== undefined) return found;
    if (context.strict) throw new Error(`缺少环境变量: ${name}`);
    return `[MISSING_ENV:${name}]`;
  });
  return withEnv.replace(STEP_RE, (_match, stepId: string, path: string) => {
    const step = context.steps?.[stepId];
    const found = step === undefined ? undefined : getLivePath(step, path);
    if (found !== undefined) return String(found);
    if (context.strict) throw new Error(`无法解析步骤引用: steps.${stepId}.${path}`);
    return `[UNRESOLVED_STEP:${stepId}.${path}]`;
  });
}

export function interpolateLiveValue(value: unknown, context: LiveInterpolationContext): unknown {
  if (typeof value === 'string') return interpolateString(value, context);
  if (Array.isArray(value)) return value.map(item => interpolateLiveValue(item, context));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, interpolateLiveValue(nested, context)]),
  );
}
