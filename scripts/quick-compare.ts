/**
 * 快速对比：只提取 Q&A，不评分
 */
import 'dotenv/config';
import { fetchWeworkMessages, WeworkMessage } from '../src/commands/wework.js';
import { extractWeworkQA, QAPair } from '../src/commands/wework-qa.js';
import {
  switchProvider,
  setModelOverride,
  getProviderName,
  getModelName,
  initProviders
} from '../src/llm/provider.js';
import fs from 'fs';

async function quickCompare() {
  console.log('\n' + '='.repeat(80));
  console.log('快速对比：OpenRouter GLM-5 vs Claude Opus 4.6');
  console.log('='.repeat(80) + '\n');

  await initProviders();

  // 1. 使用 OpenRouter GLM-5 提取
  console.log('🤖 OpenRouter GLM-5 提取中...');
  switchProvider('openrouter');
  setModelOverride('z-ai/glm-5');
  const qaA = await extractWeworkQA({
    topics: ['FIX', 'fix协议'],
    limit: 10,
    verbose: false,
  });
  console.log(`✓ 提取 ${qaA.length} 个 Q&A\n`);

  // 2. 使用 Claude Opus 4.6 提取
  console.log('🤖 Claude Opus 4.6 提取中...');
  switchProvider('anthropic');
  setModelOverride('claude-opus-4-6-20260205');
  const qaB = await extractWeworkQA({
    topics: ['FIX', 'fix协议'],
    limit: 10,
    verbose: false,
  });
  console.log(`✓ 提取 ${qaB.length} 个 Q&A\n`);

  // 3. 生成对比报告
  const report = generateReport(qaA, qaB);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = `./data/comparison-reports/quick-compare-glm5-vs-opus-${timestamp}.md`;

  fs.writeFileSync(reportPath, report);
  console.log(`\n✓ 对比报告已保存: ${reportPath}\n`);

  // 4. 显示摘要
  displaySummary(qaA, qaB);
}

function generateReport(qaA: QAPair[], qaB: QAPair[]): string {
  let report = `# 快速对比报告（无质量评分）

## 测试配置
- **主题**: FIX协议对接
- **样本数**: 10
- **测试时间**: ${new Date().toISOString()}

## 提取结果统计

| 指标 | OpenRouter GLM-5 | Claude Opus 4.6 |
|------|------------------|-----------------|
| 提取数量 | ${qaA.length} | ${qaB.length} |

---

## OpenRouter GLM-5 提取结果

`;

  qaA.forEach((qa, i) => {
    report += `
### Q&A #${i + 1}

**时间**: ${qa.time}
**群组**: ${qa.session}
**提问人**: ${qa.questioner}
**回答人**: ${qa.answerer}

**问题**:
${qa.question}

**答案**:
${qa.answer}

---
`;
  });

  report += `
## Claude Opus 4.6 提取结果

`;

  qaB.forEach((qa, i) => {
    report += `
### Q&A #${i + 1}

**时间**: ${qa.time}
**群组**: ${qa.session}
**提问人**: ${qa.questioner}
**回答人**: ${qa.answerer}

**问题**:
${qa.question}

**答案**:
${qa.answer}

---
`;
  });

  return report;
}

function displaySummary(qaA: QAPair[], qaB: QAPair[]) {
  console.log('='.repeat(80));
  console.log('对比摘要');
  console.log('='.repeat(80));
  console.log(`OpenRouter GLM-5: 提取 ${qaA.length} 个 Q&A`);
  console.log(`Claude Opus 4.6: 提取 ${qaB.length} 个 Q&A`);
  console.log('='.repeat(80));
  console.log('\n请查看报告文件进行详细对比');
}

quickCompare().catch(console.error);
