import { isDeepStrictEqual } from 'node:util';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathParts(path: string): Array<string | number> {
  if (path === '$' || path === '') return [];
  const parts: Array<string | number> = [];
  for (const match of path.matchAll(/(?:^|\.)([^.[\]]+)|\[(\d+)\]/g)) {
    if (match[1] !== undefined) parts.push(/^\d+$/.test(match[1]) ? Number(match[1]) : match[1]);
    else if (match[2] !== undefined) parts.push(Number(match[2]));
  }
  return parts;
}

export function getLivePath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of pathParts(path)) {
    if (typeof part === 'number') {
      if (!Array.isArray(current) || part >= current.length) return undefined;
      current = current[part];
      continue;
    }
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

export function liveValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function containsLiveValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string') return actual.includes(String(expected));
  if (Array.isArray(actual)) {
    return actual.some(item => (
      isDeepStrictEqual(item, expected)
      || containsLiveValue(item, expected)
    ));
  }
  if (isRecord(actual) && isRecord(expected)) {
    return Object.entries(expected).every(([key, value]) => key in actual && isDeepStrictEqual(actual[key], value));
  }
  return JSON.stringify(actual).includes(JSON.stringify(expected));
}

export function liveValuesEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
