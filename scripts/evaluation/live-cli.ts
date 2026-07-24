import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  CanaryCase,
  CanaryCaseResult,
  ContractCase,
  ContractCaseResult,
  LiveCaseStatus,
  LiveRunManifest,
} from '../../src/evaluation/live-types.js';
import { createLiveRunManifest, liveRunMarkdown } from '../../src/evaluation/live-report.js';

export interface LiveCliOptions {
  dryRun: boolean;
  includeDraft: boolean;
  caseId?: string;
  output?: string;
}

export function parseLiveCliOptions(argv = process.argv.slice(2)): LiveCliOptions {
  const value = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    return argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  };
  return {
    dryRun: argv.includes('--dry-run'),
    includeDraft: argv.includes('--include-draft'),
    caseId: value('case'),
    output: value('output'),
  };
}

export function selectedStatuses(includeDraft: boolean): LiveCaseStatus[] {
  return includeDraft ? ['approved', 'draft'] : ['approved'];
}

export function selectCase<T extends { id: string }>(cases: T[], caseId?: string): T[] {
  if (!caseId) return cases;
  const selected = cases.filter(item => item.id === caseId);
  if (selected.length === 0) throw new Error(`未找到 live case: ${caseId}`);
  return selected;
}

export function dryContractResults(cases: ContractCase[]): ContractCaseResult[] {
  return cases.map(item => ({
    caseId: item.id,
    risk: item.risk,
    status: 'inconclusive',
    steps: [],
    durationMs: 0,
  }));
}

export function dryCanaryResults(cases: CanaryCase[]): CanaryCaseResult[] {
  return cases.map(item => ({
    caseId: item.id,
    risk: item.risk,
    status: 'inconclusive',
    passRate: 0,
    repetitions: [],
  }));
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function writeLiveReport(
  manifest: LiveRunManifest,
  output?: string,
): { jsonPath: string; markdownPath: string } {
  const jsonPath = resolve(output ?? `data/evaluation/runs/${manifest.kind}-${timestamp()}.json`);
  const markdownPath = jsonPath.replace(/\.json$/i, '') + '.md';
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, `${liveRunMarkdown(manifest)}\n`, 'utf8');
  return { jsonPath, markdownPath };
}

export function buildManifest(input: {
  kind: 'contract' | 'canary';
  target: 'staging' | 'production';
  dryRun: boolean;
  cases: ContractCase[] | CanaryCase[];
  results: ContractCaseResult[] | CanaryCaseResult[];
  missingEnv: string[];
}): LiveRunManifest {
  return createLiveRunManifest({
    kind: input.kind,
    target: input.target,
    dryRun: input.dryRun,
    cases: input.cases,
    results: input.results,
    missingEnv: input.missingEnv,
  });
}
