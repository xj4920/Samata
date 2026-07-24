import { runCanaryCases } from '../../src/evaluation/canary-runner.js';
import { loadCanaryCases } from '../../src/evaluation/live-loader.js';
import { initializeCanaryRuntime } from '../../src/evaluation/live-runtime.js';
import { inspectCanaryGuard } from '../../src/evaluation/live-safety.js';
import {
  buildManifest,
  dryCanaryResults,
  parseLiveCliOptions,
  selectCase,
  selectedStatuses,
  writeLiveReport,
} from './live-cli.js';

async function main(): Promise<void> {
  const options = parseLiveCliOptions();
  const cases = selectCase(
    loadCanaryCases({ statuses: selectedStatuses(options.includeDraft) }),
    options.caseId,
  );
  if (cases.length === 0) throw new Error('没有可运行的 Canary case');
  const guards = cases.map(item => ({ item, guard: inspectCanaryGuard(item, process.env) }));
  const missingEnv = [...new Set(guards.flatMap(item => item.guard.missingEnv))].sort();

  if (options.dryRun) {
    const manifest = buildManifest({
      kind: 'canary',
      target: 'production',
      dryRun: true,
      cases,
      results: dryCanaryResults(cases),
      missingEnv,
    });
    const paths = writeLiveReport(manifest, options.output);
    console.log(`Canary dry-run: cases=${cases.length}, missing_env=${missingEnv.length}`);
    for (const { item, guard } of guards) {
      console.log(`- ${item.id}: ${guard.allowed ? 'ready' : 'blocked'}${guard.issues.length ? ` (${guard.issues.join('; ')})` : ''}`);
    }
    console.log(`report: ${paths.jsonPath}`);
    return;
  }

  const blocked = guards.filter(item => !item.guard.allowed);
  if (blocked.length > 0) {
    throw new Error(blocked.map(({ item, guard }) => (
      `${item.id}: missing=[${guard.missingEnv.join(', ')}], issues=[${guard.issues.join('; ')}]`
    )).join('\n'));
  }

  const runtime = await initializeCanaryRuntime(process.env, cases);
  try {
    const results = await runCanaryCases(cases, runtime.execute, process.env);
    const manifest = buildManifest({
      kind: 'canary',
      target: 'production',
      dryRun: false,
      cases,
      results,
      missingEnv: [],
    });
    const paths = writeLiveReport(manifest, options.output);
    console.log(`Canary: passed=${results.filter(item => item.status === 'passed').length}/${results.length}`);
    console.log(`report: ${paths.jsonPath}`);
    if (results.some(item => item.status !== 'passed')) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
