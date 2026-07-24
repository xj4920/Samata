import { loadContractCases, liveCaseSetHash } from '../../src/evaluation/live-loader.js';
import { validateLiveToolSafety } from '../../src/evaluation/live-safety.js';

const cases = loadContractCases();
const issues = cases.flatMap(item => (
  validateLiveToolSafety(item.safety, item.steps.map(step => step.tool))
    .map(message => `${item.id}: ${message}`)
));
if (issues.length > 0) throw new Error(issues.join('\n'));

console.log(`contract case count: ${cases.length}`);
console.log(`approved: ${cases.filter(item => item.status === 'approved').length}`);
console.log(`case set hash: ${liveCaseSetHash(cases)}`);
