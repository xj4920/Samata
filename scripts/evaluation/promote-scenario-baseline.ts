import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { stripSensitiveRunDetails } from '../../src/evaluation/report.js';
import type { ScenarioRunManifest } from '../../src/evaluation/types.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length);
}

const runPath = arg('run');
const name = arg('name');
if (!runPath || !name || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
  throw new Error('用法: --run=<run.json> --name=<baseline-name>');
}
const manifest = JSON.parse(readFileSync(resolve(runPath), 'utf8')) as ScenarioRunManifest;
if (manifest.gitDirty) throw new Error('dirty 工作区产生的结果不能提升为正式 baseline');
if (manifest.cases.some(item => item.status !== 'passed')) {
  throw new Error('包含 failed/error/inconclusive case 的结果不能提升为正式 baseline');
}

const output = resolve(`evals/baselines/${name}.json`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(stripSensitiveRunDetails(manifest), null, 2)}\n`, 'utf8');
console.log(`baseline 已生成: ${output}`);
