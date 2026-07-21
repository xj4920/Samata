import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { stringify } from 'yaml';
import { containsLikelySecret, redactText } from '../../src/evaluation/redaction.js';
import type {
  ScenarioCase,
  TelemetryCandidateReport,
  TelemetryScenarioCandidate,
  ToolFixture,
} from '../../src/evaluation/types.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function allArgs(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.slice(2)
    .filter(value => value.startsWith(prefix))
    .map(value => value.slice(prefix.length))
    .filter(Boolean);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'case';
}

function risk(candidate: TelemetryScenarioCandidate): ScenarioCase['risk'] {
  const toolNames = candidate.toolCalls.map(tool => tool.name).join(' ');
  if (/send|deliver|delete|update|create|schedule|reminder|write|exec/i.test(toolNames)) return 'high';
  if (candidate.metrics.toolFailures > 0 || candidate.metrics.totalToolCalls >= 5) return 'medium';
  return 'low';
}

function fixtures(candidate: TelemetryScenarioCandidate): ToolFixture[] {
  const grouped = new Map<string, ToolFixture>();
  for (const call of candidate.toolCalls) {
    const fixture = grouped.get(call.name) ?? { tool: call.name, responses: [] };
    let input: unknown;
    try { input = call.input ? JSON.parse(call.input) : undefined; } catch { input = call.input; }
    fixture.responses.push({
      input: input === undefined ? { mode: 'any' } : { mode: 'exact', value: input },
      output: call.outputPreview ?? (call.error ? { error: call.error } : { fixture_pending: true }),
      success: call.success,
      error: call.error,
    });
    grouped.set(call.name, fixture);
  }
  return [...grouped.values()];
}

function toCase(candidate: TelemetryScenarioCandidate, index: number): ScenarioCase {
  const tools = [...new Set(candidate.toolCalls.map(tool => tool.name))];
  return {
    version: 1,
    id: `${candidate.scenario}-${String(index).padStart(3, '0')}-${candidate.turnHash.slice(0, 8)}`,
    title: `${candidate.scenario} 候选 ${index}`,
    scenario: candidate.scenario,
    status: 'draft',
    risk: risk(candidate),
    priority: Math.max(1, Math.round(candidate.priorityScore)),
    tags: candidate.suggestedTags,
    source: {
      turnHash: candidate.turnHash,
      observedAt: candidate.observedAt,
      telemetryIncomplete: true,
      notes: '由 telemetry preview 生成。审核前必须补齐完整 fixture、事实断言和评分 rubric。',
    },
    input: {
      text: candidate.question,
      agent: candidate.agent,
      role: 'user',
      channel: candidate.channel,
      fixedTime: candidate.observedAt,
    },
    fixtures: fixtures(candidate),
    assertions: {
      allowedTools: tools,
      maxToolCalls: candidate.metrics.totalToolCalls + 2,
      maxLoopRounds: candidate.metrics.loopRounds + 2,
    },
    judge: { enabled: false },
    execution: { mode: 'frozen', repetitions: 1, timeoutMs: 120_000 },
    review: {
      notes: '待人工审核；不得直接改为 approved。',
    },
  };
}

const inputPath = arg('input');
if (!inputPath) throw new Error('用法: --input=<candidates.json> [--per-scenario=3] [--output-dir=data/evaluation/draft-cases]');
const perScenario = Math.max(1, Number(arg('per-scenario') ?? 3));
const outputDir = resolve(arg('output-dir') ?? 'data/evaluation/draft-cases');
const redactionTerms = allArgs('redact-term');
const report = JSON.parse(readFileSync(resolve(inputPath), 'utf8')) as TelemetryCandidateReport;
const counts = new Map<string, number>();
let written = 0;

for (const candidate of report.candidates) {
  const current = counts.get(candidate.scenario) ?? 0;
  if (current >= perScenario) continue;
  const index = current + 1;
  counts.set(candidate.scenario, index);
  const scenarioCase = toCase({
    ...candidate,
    question: redactText(candidate.question, { terms: redactionTerms }),
  }, index);
  const yaml = stringify(scenarioCase, { lineWidth: 120 });
  if (containsLikelySecret(yaml)) {
    throw new Error(`候选 ${candidate.candidateId} 仍包含疑似敏感内容，拒绝生成 draft`);
  }
  const path = resolve(outputDir, candidate.scenario, `${slug(scenarioCase.id)}.yaml`);
  if (existsSync(path)) continue;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml, 'utf8');
  written++;
}

console.log(`draft 输出目录: ${outputDir}`);
console.log(`生成 draft: ${written}`);
for (const [scenario, count] of [...counts.entries()].sort()) console.log(`${scenario}: ${count}`);
