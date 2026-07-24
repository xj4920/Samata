import { loadCanaryCases, liveCaseSetHash } from '../../src/evaluation/live-loader.js';
import { validateLiveToolSafety } from '../../src/evaluation/live-safety.js';

const cases = loadCanaryCases();
const issues = cases.flatMap(item => (
  validateLiveToolSafety(item.safety, item.allowedTools)
    .map(message => `${item.id}: ${message}`)
));
if (issues.length > 0) throw new Error(issues.join('\n'));

console.log(`canary case count: ${cases.length}`);
console.log(`approved: ${cases.filter(item => item.status === 'approved').length}`);
console.log(`case set hash: ${liveCaseSetHash(cases)}`);
