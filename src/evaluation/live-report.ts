import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  CanaryCase,
  CanaryCaseResult,
  ContractCase,
  ContractCaseResult,
  LiveRunManifest,
} from './live-types.js';
import { liveCaseSetHash } from './live-loader.js';

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function packageVersion(): string {
  try {
    return JSON.parse(readFileSync('package.json', 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createLiveRunManifest(input: {
  kind: 'contract' | 'canary';
  target: 'staging' | 'production';
  dryRun: boolean;
  cases: Array<ContractCase | CanaryCase>;
  results: ContractCaseResult[] | CanaryCaseResult[];
  missingEnv?: string[];
}): LiveRunManifest {
  return {
    runId: randomUUID(),
    kind: input.kind,
    target: input.target,
    dryRun: input.dryRun,
    createdAt: new Date().toISOString(),
    gitSha: git(['rev-parse', 'HEAD']),
    gitDirty: git(['status', '--porcelain']) !== '',
    caseSetHash: liveCaseSetHash(input.cases),
    packageVersion: packageVersion(),
    missingEnv: [...new Set(input.missingEnv ?? [])].sort(),
    cases: input.results,
  };
}

export function liveRunMarkdown(manifest: LiveRunManifest): string {
  const statusCounts = new Map<string, number>();
  for (const item of manifest.cases) statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1);
  const lines = [
    `# ${manifest.kind === 'contract' ? '工具契约' : '生产 Canary'}报告`,
    '',
    `- Run ID：${manifest.runId}`,
    `- Target：${manifest.target}`,
    `- Dry-run：${manifest.dryRun ? '是' : '否'}`,
    `- Package：${manifest.packageVersion}`,
    `- Git：${manifest.gitSha}${manifest.gitDirty ? '（dirty）' : ''}`,
    `- Case set hash：${manifest.caseSetHash}`,
    `- 状态：${[...statusCounts.entries()].map(([status, count]) => `${status}=${count}`).join(', ') || '无'}`,
    `- 缺少环境变量：${manifest.missingEnv.join(', ') || '无'}`,
    '',
    '| Case | 风险 | 状态 |',
    '|---|---|---|',
    ...manifest.cases.map(item => `| ${item.caseId} | ${item.risk} | ${item.status} |`),
    '',
  ];
  return lines.join('\n');
}
