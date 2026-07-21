import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, resolve } from 'path';
import { parse } from 'yaml';
import { asScenarioCase, validateTaxonomy } from './case-validator.js';
import type { ScenarioCase, ScenarioTaxonomy } from './types.js';

function yamlFiles(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) output.push(...yamlFiles(path));
    else if (['.yaml', '.yml'].includes(extname(path))) output.push(path);
  }
  return output;
}

export function loadScenarioTaxonomy(path = resolve(process.cwd(), 'evals/taxonomy.yaml')): ScenarioTaxonomy {
  const value = parse(readFileSync(path, 'utf8')) as unknown;
  const result = validateTaxonomy(value);
  if (!result.valid) {
    const detail = result.issues.map(issue => `${issue.path}: ${issue.message}`).join('; ');
    throw new Error(`场景 taxonomy 校验失败: ${detail}`);
  }
  return value as ScenarioTaxonomy;
}

export interface LoadScenarioCasesOptions {
  root?: string;
  taxonomy?: ScenarioTaxonomy;
  statuses?: ScenarioCase['status'][];
}

export function loadScenarioCases(options: LoadScenarioCasesOptions = {}): ScenarioCase[] {
  const root = options.root ?? resolve(process.cwd(), 'evals/cases');
  const taxonomy = options.taxonomy ?? loadScenarioTaxonomy();
  const statuses = options.statuses ? new Set(options.statuses) : undefined;
  const seen = new Map<string, string>();

  return yamlFiles(root).flatMap(path => {
    const value = parse(readFileSync(path, 'utf8')) as unknown;
    const scenarioCase = asScenarioCase(value, taxonomy);
    const previous = seen.get(scenarioCase.id);
    if (previous) throw new Error(`重复场景 case id ${scenarioCase.id}: ${previous}, ${path}`);
    seen.set(scenarioCase.id, path);
    if (statuses && !statuses.has(scenarioCase.status)) return [];
    return [scenarioCase];
  });
}

export function scenarioCaseSetHash(cases: ScenarioCase[]): string {
  const normalized = [...cases]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(item => JSON.stringify(item))
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}
