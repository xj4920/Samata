import { isDeepStrictEqual } from 'util';
import type { ToolInputMatcher } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSubset(expected: unknown, actual: unknown): boolean {
  if (isDeepStrictEqual(expected, actual)) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length > actual.length) return false;
    return expected.every((item, index) => isSubset(item, actual[index]));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([key, value]) => key in actual && isSubset(value, actual[key]));
  }
  return false;
}

export function matchesToolInput(matcher: ToolInputMatcher, actual: unknown): boolean {
  switch (matcher.mode) {
    case 'any':
      return true;
    case 'exact':
      return isDeepStrictEqual(matcher.value, actual);
    case 'subset':
      return isSubset(matcher.value, actual);
    case 'contains': {
      if (typeof actual === 'string' && typeof matcher.value === 'string') {
        return actual.includes(matcher.value);
      }
      if (Array.isArray(actual)) {
        return actual.some(item => isDeepStrictEqual(item, matcher.value));
      }
      return JSON.stringify(actual).includes(JSON.stringify(matcher.value));
    }
    default:
      return false;
  }
}
