import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { CanaryCase, ContractCase, LiveCaseStatus } from './live-types.js';
import { asCanaryCase, asContractCase } from './live-validator.js';

function yamlFiles(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) output.push(...yamlFiles(path));
    else if (['.yaml', '.yml'].includes(extname(path))) output.push(path);
  }
  return output;
}

function loadCases<T extends { id: string; status: LiveCaseStatus }>(
  root: string,
  parser: (value: unknown) => T,
  statuses?: LiveCaseStatus[],
): T[] {
  const allowed = statuses ? new Set(statuses) : undefined;
  const seen = new Map<string, string>();
  return yamlFiles(root).flatMap(path => {
    const item = parser(parse(readFileSync(path, 'utf8')) as unknown);
    const previous = seen.get(item.id);
    if (previous) throw new Error(`重复 live case id ${item.id}: ${previous}, ${path}`);
    seen.set(item.id, path);
    return allowed && !allowed.has(item.status) ? [] : [item];
  });
}

export function loadContractCases(options: { root?: string; statuses?: LiveCaseStatus[] } = {}): ContractCase[] {
  return loadCases(
    options.root ?? resolve(process.cwd(), 'evals/contracts'),
    asContractCase,
    options.statuses,
  );
}

export function loadCanaryCases(options: { root?: string; statuses?: LiveCaseStatus[] } = {}): CanaryCase[] {
  return loadCases(
    options.root ?? resolve(process.cwd(), 'evals/canary'),
    asCanaryCase,
    options.statuses,
  );
}

export function liveCaseSetHash(cases: Array<ContractCase | CanaryCase>): string {
  const normalized = [...cases]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(item => JSON.stringify(item))
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}
