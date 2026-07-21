import { loadScenarioCases, loadScenarioTaxonomy, scenarioCaseSetHash } from '../../src/evaluation/case-loader.js';

const taxonomy = loadScenarioTaxonomy();
const cases = loadScenarioCases({ taxonomy });
const coverage = new Map<string, { total: number; approved: number }>();
for (const scenario of taxonomy.scenarios) coverage.set(scenario.id, { total: 0, approved: 0 });
for (const scenarioCase of cases) {
  const item = coverage.get(scenarioCase.scenario)!;
  item.total++;
  if (scenarioCase.status === 'approved') item.approved++;
}

console.log(`taxonomy version: ${taxonomy.version}`);
console.log(`case count: ${cases.length}`);
console.log(`case set hash: ${scenarioCaseSetHash(cases)}`);
for (const [scenario, counts] of coverage) {
  const warning = counts.approved > 0 && counts.approved < 3 ? ' [覆盖不足]' : '';
  console.log(`${scenario}: total=${counts.total}, approved=${counts.approved}${warning}`);
}
