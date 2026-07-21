import { readFileSync } from 'fs';
import { resolve } from 'path';
import { evaluateScenarioGate, loadScenarioGateConfig } from '../../src/evaluation/gate.js';
import type { ScenarioRunManifest } from '../../src/evaluation/types.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function manifest(path: string): ScenarioRunManifest {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as ScenarioRunManifest;
}

const currentPath = arg('current');
if (!currentPath) throw new Error('用法: --current=<run.json> [--baseline=<baseline.json>] [--config=<gates.yaml>]');
const baselinePath = arg('baseline');
const result = evaluateScenarioGate(
  manifest(currentPath),
  loadScenarioGateConfig(arg('config') ? resolve(arg('config')!) : undefined),
  baselinePath ? manifest(baselinePath) : undefined,
);

console.log(result.passed ? '场景回归门禁：通过' : '场景回归门禁：失败');
for (const failure of result.failures) console.log(`FAIL: ${failure}`);
for (const warning of result.warnings) console.log(`WARN: ${warning}`);
if (!result.passed) process.exitCode = 1;
