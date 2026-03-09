/**
 * 模型对比提取脚本
 * 使用两个不同的模型提取同一批消息的 Q&A，对比质量差异
 *
 * Usage: npx tsx scripts/compare-extraction-models.ts
 */
import 'dotenv/config';
import { fetchWeworkMessages, WeworkMessage } from '../src/commands/wework.js';
import { extractWeworkQA, QAPair } from '../src/commands/wework-qa.js';
import { scoreQAQuality } from '../src/utils/qa-quality-scorer.js';
import { log } from '../src/utils/logger.js';
import {
  switchProvider,
  setModelOverride,
  getProviderName,
  getModelName,
  initProviders
} from '../src/llm/provider.js';
import fs from 'fs';
import path from 'path';

interface ComparisonConfig {
  modelA: {
    provider: string;
    model: string;
    name: string;
  };
  modelB: {
    provider: string;
    model: string;
    name: string;
  };
  testTopic: {
    name: string;
    keywords: string[];
    session?: string;
    startDate?: string;
    endDate?: string;
  };
  sampleSize: number; // 提取多少个 Q&A 用于对比
}

const DEFAULT_CONFIG: ComparisonConfig = {
  modelA: {
    provider: process.env.COMPARISON_PROVIDER_A || 'minimax',
    model: process.env.COMPARISON_MODEL_A || 'MiniMax-M2.5-highspeed',
    name: 'MiniMax-2.5',
  },
  modelB: {
    provider: process.env.COMPARISON_PROVIDER_B || 'anthropic',
    model: process.env.COMPARISON_MODEL_B || 'claude-opus-4-6-20260205',
    name: 'Claude Opus 4.6',
  },
  testTopic: {
    name: 'FIX协议对接',
    keywords: ['FIX', 'fix协议', 'fix接入'],
    // session: 'LinkRiver- GF-多空交易群',
  },
  sampleSize: 10,
};

async function compareModels(config: ComparisonConfig = DEFAULT_CONFIG) {
  console.log('\n' + '='.repeat(80));
  console.log('模型对比提取');
  console.log('='.repeat(80));
  console.log(`主题: ${config.testTopic.name}`);
  console.log(`关键词: ${config.testTopic.keywords.join(', ')}`);
  console.log(`模型 A: ${config.modelA.name} (${config.modelA.provider}/${config.modelA.model})`);
  console.log(`模型 B: ${config.modelB.name} (${config.modelB.provider}/${config.modelB.model})`);
  console.log(`样本数: ${config.sampleSize}`);
  console.log('='.repeat(80) + '\n');

  // 初始化 providers
  await initProviders();

  // 1. 获取测试消息
  log.print('📥 获取测试消息...');
  const messages = await fetchTestMessages(config.testTopic);

  if (messages.length === 0) {
    log.print('❌ 未找到测试消息');
    return;
  }

  log.print(`✓ 找到 ${messages.length} 条消息\n`);

  // 2. 使用模型 A 提取
  log.print(`🤖 使用 ${config.modelA.name} 提取 Q&A...`);
  const qaA = await extractWithModel(
    config.testTopic,
    config.modelA.provider,
    config.modelA.model,
    config.sampleSize
  );
  log.print(`✓ 提取 ${qaA.length} 个 Q&A\n`);

  // 3. 使用模型 B 提取
  log.print(`🤖 使用 ${config.modelB.name} 提取 Q&A...`);
  const qaB = await extractWithModel(
    config.testTopic,
    config.modelB.provider,
    config.modelB.model,
    config.sampleSize
  );
  log.print(`✓ 提取 ${qaB.length} 个 Q&A\n`);

  // 4. 质量评分（使用第三方模型评分，避免偏见）
  log.print('📊 评估 Q&A 质量...');
  const scoresA = await scoreQAPairs(qaA);
  const scoresB = await scoreQAPairs(qaB);
  log.print('✓ 评分完成\n');

  // 5. 生成对比报告
  const report = generateComparisonReport(
    config,
    qaA,
    qaB,
    scoresA,
    scoresB
  );

  // 6. 保存报告
  const reportDir = './data/comparison-reports';
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(
    reportDir,
    `comparison-${config.modelA.name}-vs-${config.modelB.name}-${timestamp}.md`
  );

  fs.writeFileSync(reportPath, report);
  log.print(`\n✓ 对比报告已保存: ${reportPath}\n`);

  // 7. 显示摘要
  displaySummary(qaA, qaB, scoresA, scoresB, config);
}

async function fetchTestMessages(topic: {
  keywords: string[];
  session?: string;
  startDate?: string;
  endDate?: string;
}): Promise<WeworkMessage[]> {
  const allMessages: WeworkMessage[] = [];
  const messageIds = new Set<string>();

  for (const keyword of topic.keywords) {
    const messages = await fetchWeworkMessages({
      keyword: keyword.trim(),
      session: topic.session,
      limit: 500,
    });

    for (const msg of messages) {
      const msgId = `${msg.time}-${msg.sender}-${msg.content}`;
      if (!messageIds.has(msgId)) {
        messageIds.add(msgId);
        allMessages.push(msg);
      }
    }
  }

  // 按时间排序
  allMessages.sort((a, b) => a.time.localeCompare(b.time));

  // 时间过滤
  let filtered = allMessages;
  if (topic.startDate) {
    filtered = filtered.filter((m) => m.time >= topic.startDate!);
  }
  if (topic.endDate) {
    filtered = filtered.filter((m) => m.time <= topic.endDate! + ' 23:59:59');
  }

  return filtered;
}

async function extractWithModel(
  topic: { name: string; keywords: string[]; session?: string },
  provider: string,
  model: string,
  limit: number
): Promise<QAPair[]> {
  // 切换到指定的 provider 和 model
  switchProvider(provider as any);
  setModelOverride(model);

  log.dim(`  当前 provider: ${getProviderName()}, model: ${getModelName()}`);

  // 提取 Q&A
  const qaPairs = await extractWeworkQA({
    topics: topic.keywords,
    session: topic.session,
    limit,
    verbose: false,
  });

  return qaPairs;
}

async function scoreQAPairs(qaPairs: QAPair[]): Promise<number[]> {
  const scores: number[] = [];

  for (const qa of qaPairs) {
    const result = await scoreQAQuality(qa);
    scores.push(result.score);
    await sleep(1000);
  }

  return scores;
}

function generateComparisonReport(
  config: ComparisonConfig,
  qaA: QAPair[],
  qaB: QAPair[],
  scoresA: number[],
  scoresB: number[]
): string {
  const avgA = scoresA.reduce((a, b) => a + b, 0) / scoresA.length || 0;
  const avgB = scoresB.reduce((a, b) => a + b, 0) / scoresB.length || 0;

  let report = `# 模型对比提取报告

## 测试配置

- **主题**: ${config.testTopic.name}
- **关键词**: ${config.testTopic.keywords.join(', ')}
- **样本数**: ${config.sampleSize}
- **测试时间**: ${new Date().toISOString()}

## 模型信息

### 模型 A: ${config.modelA.name}
- Provider: ${config.modelA.provider}
- Model: ${config.modelA.model}

### 模型 B: ${config.modelB.name}
- Provider: ${config.modelB.provider}
- Model: ${config.modelB.model}

## 提取结果统计

| 指标 | ${config.modelA.name} | ${config.modelB.name} |
|------|----------------------|----------------------|
| 提取数量 | ${qaA.length} | ${qaB.length} |
| 平均质量评分 | ${avgA.toFixed(2)} | ${avgB.toFixed(2)} |
| 最高分 | ${Math.max(...scoresA)} | ${Math.max(...scoresB)} |
| 最低分 | ${Math.min(...scoresA)} | ${Math.min(...scoresB)} |
| 高质量(≥4分) | ${scoresA.filter(s => s >= 4).length} | ${scoresB.filter(s => s >= 4).length} |
| 低质量(≤2分) | ${scoresA.filter(s => s <= 2).length} | ${scoresB.filter(s => s <= 2).length} |

---

## ${config.modelA.name} 提取结果

`;

  qaA.forEach((qa, i) => {
    report += `
### Q&A #${i + 1} (评分: ${scoresA[i]}/5)

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
## ${config.modelB.name} 提取结果

`;

  qaB.forEach((qa, i) => {
    report += `
### Q&A #${i + 1} (评分: ${scoresB[i]}/5)

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
## 结论

`;

  if (avgA > avgB) {
    report += `${config.modelA.name} 在本次测试中表现更好，平均质量评分高出 ${(avgA - avgB).toFixed(2)} 分。\n`;
  } else if (avgB > avgA) {
    report += `${config.modelB.name} 在本次测试中表现更好，平均质量评分高出 ${(avgB - avgA).toFixed(2)} 分。\n`;
  } else {
    report += `两个模型在本次测试中表现相当。\n`;
  }

  return report;
}

function displaySummary(
  qaA: QAPair[],
  qaB: QAPair[],
  scoresA: number[],
  scoresB: number[],
  config: ComparisonConfig
) {
  const avgA = scoresA.reduce((a, b) => a + b, 0) / scoresA.length || 0;
  const avgB = scoresB.reduce((a, b) => a + b, 0) / scoresB.length || 0;

  console.log('='.repeat(80));
  console.log('对比摘要');
  console.log('='.repeat(80));
  console.log(`${config.modelA.name}:`);
  console.log(`  提取数量: ${qaA.length}`);
  console.log(`  平均评分: ${avgA.toFixed(2)}/5.0`);
  console.log(`  高质量(≥4分): ${scoresA.filter(s => s >= 4).length}`);
  console.log(`  低质量(≤2分): ${scoresA.filter(s => s <= 2).length}`);
  console.log();
  console.log(`${config.modelB.name}:`);
  console.log(`  提取数量: ${qaB.length}`);
  console.log(`  平均评分: ${avgB.toFixed(2)}/5.0`);
  console.log(`  高质量(≥4分): ${scoresB.filter(s => s >= 4).length}`);
  console.log(`  低质量(≤2分): ${scoresB.filter(s => s <= 2).length}`);
  console.log('='.repeat(80));

  if (avgA > avgB) {
    console.log(`\n🏆 ${config.modelA.name} 胜出 (+${(avgA - avgB).toFixed(2)} 分)`);
  } else if (avgB > avgA) {
    console.log(`\n🏆 ${config.modelB.name} 胜出 (+${(avgB - avgA).toFixed(2)} 分)`);
  } else {
    console.log('\n🤝 平局');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 运行对比
compareModels().catch(console.error);
