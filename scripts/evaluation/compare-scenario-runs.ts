import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { compareScenarioRuns, scenarioComparisonMarkdown } from '../../src/evaluation/compare.js';
import type { ScenarioRunManifest } from '../../src/evaluation/types.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length);
}

const baselinePath = arg('baseline');
const currentPath = arg('current');
if (!baselinePath || !currentPath) {
  throw new Error('用法: --baseline=<baseline.json> --current=<current.json> [--output=<report.md>]');
}
const baseline = JSON.parse(readFileSync(resolve(baselinePath), 'utf8')) as ScenarioRunManifest;
const current = JSON.parse(readFileSync(resolve(currentPath), 'utf8')) as ScenarioRunManifest;
const comparison = compareScenarioRuns(baseline, current);
const markdown = scenarioComparisonMarkdown(comparison);
const output = arg('output');
if (output) writeFileSync(resolve(output), markdown, 'utf8');
else process.stdout.write(markdown);

if (comparison.regressions.length > 0 || comparison.removedCases.length > 0) process.exitCode = 1;
