import { mkdirSync, readdirSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { loadScenarioTaxonomy } from '../../src/evaluation/case-loader.js';
import { readTelemetryCandidates } from '../../src/evaluation/telemetry-reader.js';
import type { TelemetryCandidateReport } from '../../src/evaluation/types.js';

interface CliOptions {
  files: string[];
  from?: string;
  to?: string;
  agent?: string;
  channel?: string;
  minToolCalls?: number;
  limit: number;
  minPerScenario: number;
  output?: string;
  report?: string;
  redactTerms: string[];
}

function valueArg(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseArgs(args: string[]): CliOptions {
  const files = args.filter(arg => !arg.startsWith('--')).map(path => resolve(path));
  const limit = Number(valueArg(args, 'limit') ?? 200);
  const minToolCallsRaw = valueArg(args, 'min-tool-calls');
  const minPerScenario = Number(valueArg(args, 'min-per-scenario') ?? 5);
  return {
    files,
    from: valueArg(args, 'from'),
    to: valueArg(args, 'to'),
    agent: valueArg(args, 'agent'),
    channel: valueArg(args, 'channel'),
    minToolCalls: minToolCallsRaw === undefined ? undefined : Number(minToolCallsRaw),
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200,
    minPerScenario: Number.isFinite(minPerScenario) && minPerScenario > 0 ? Math.floor(minPerScenario) : 5,
    output: valueArg(args, 'output'),
    report: valueArg(args, 'report'),
    redactTerms: args
      .filter(arg => arg.startsWith('--redact-term='))
      .map(arg => arg.slice('--redact-term='.length))
      .filter(Boolean),
  };
}

function balancedCandidates<T extends { scenario: string; priorityScore: number; candidateId: string }>(
  candidates: T[],
  limit: number,
  minPerScenario: number,
): T[] {
  const selected = new Map<string, T>();
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.scenario) ?? [];
    group.push(candidate);
    groups.set(candidate.scenario, group);
  }
  for (const group of groups.values()) {
    for (const candidate of group.slice(0, minPerScenario)) selected.set(candidate.candidateId, candidate);
  }
  for (const candidate of candidates) {
    if (selected.size >= limit) break;
    selected.set(candidate.candidateId, candidate);
  }
  return [...selected.values()]
    .sort((left, right) => right.priorityScore - left.priorityScore || left.candidateId.localeCompare(right.candidateId))
    .slice(0, limit);
}

function defaultFiles(options: CliOptions): string[] {
  if (options.files.length > 0) return options.files;
  const logsDir = resolve(process.cwd(), 'logs');
  return readdirSync(logsDir)
    .filter(name => /^telemetry-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .map(name => join(logsDir, name));
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function markdown(report: TelemetryCandidateReport): string {
  const lines = [
    '# 场景评测候选报告',
    '',
    `- 生成时间：${report.generatedAt}`,
    `- telemetry turn：${report.totalTurns}`,
    `- 符合过滤条件：${report.eligibleTurns}`,
    `- 去重后候选：${report.candidates.length}`,
    `- 损坏日志行：${report.malformedLines}`,
    '',
    '## 场景覆盖',
    '',
    '| 场景 | 候选簇 | 原始 turn |',
    '|---|---:|---:|',
    ...report.coverage.map(item => `| ${item.scenario} | ${item.candidates} | ${item.turns} |`),
    '',
    '## 高优先级候选',
    '',
    '| 优先级 | 场景 | 聚类数 | Agent | 标签 | 用户请求（已脱敏） | 工具链 |',
    '|---:|---|---:|---|---|---|---|',
    ...report.candidates.map(candidate => {
      const chain = candidate.toolCalls.map(tool => `${tool.name}${tool.success ? '✓' : '✗'}`).join(' → ') || '无工具';
      return `| ${candidate.priorityScore} | ${candidate.scenario} | ${candidate.clusterSize} | ${escapeCell(candidate.agent)} | ${candidate.suggestedTags.join(', ')} | ${escapeCell(candidate.question.slice(0, 160))} | ${escapeCell(chain)} |`;
    }),
    '',
    '> telemetry 仅保存回答和工具输出预览。本报告只用于选择候选，不能直接作为标准答案或完整 fixture。',
    '',
  ];
  return lines.join('\n');
}

const options = parseArgs(process.argv.slice(2));
const sourceFiles = defaultFiles(options);
if (sourceFiles.length === 0) throw new Error('未找到 telemetry JSONL 文件');

const taxonomy = loadScenarioTaxonomy();
const readResult = readTelemetryCandidates(
  sourceFiles,
  taxonomy,
  {
    from: options.from,
    to: options.to,
    agent: options.agent,
    channel: options.channel,
    minToolCalls: options.minToolCalls,
  },
  { terms: options.redactTerms },
);
const candidates = balancedCandidates(readResult.candidates, options.limit, options.minPerScenario);
const coverageMap = new Map<string, { candidates: number; turns: number }>();
for (const candidate of candidates) {
  const current = coverageMap.get(candidate.scenario) ?? { candidates: 0, turns: 0 };
  current.candidates++;
  current.turns += candidate.clusterSize;
  coverageMap.set(candidate.scenario, current);
}

const generatedAt = new Date().toISOString();
const tag = generatedAt.replace(/[:.]/g, '-');
const jsonPath = resolve(options.output ?? `data/evaluation/candidates/candidates-${tag}.json`);
const markdownPath = resolve(options.report ?? `docs/report/scenario-evaluation/candidates-${tag}.md`);
const report: TelemetryCandidateReport = {
  version: 1,
  generatedAt,
  sourceFiles: sourceFiles.map(path => basename(path)),
  totalTurns: readResult.totalTurns,
  eligibleTurns: readResult.eligibleTurns,
  malformedLines: readResult.malformedLines,
  candidates,
  coverage: [...coverageMap.entries()]
    .map(([scenario, counts]) => ({ scenario, ...counts }))
    .sort((left, right) => right.turns - left.turns || left.scenario.localeCompare(right.scenario)),
};

mkdirSync(resolve(jsonPath, '..'), { recursive: true });
mkdirSync(resolve(markdownPath, '..'), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
writeFileSync(markdownPath, markdown(report), 'utf8');

console.log(`候选 JSON: ${jsonPath}`);
console.log(`候选报告: ${markdownPath}`);
console.log(`turn=${report.totalTurns}, eligible=${report.eligibleTurns}, candidates=${report.candidates.length}, malformed=${report.malformedLines}`);
