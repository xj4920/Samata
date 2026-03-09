/**
 * 测试主题专属 prompt 的提取效果
 */
import 'dotenv/config';
import { extractWeworkQA } from '../src/commands/wework-qa.js';
import { initProviders, switchProvider, setModelOverride } from '../src/llm/provider.js';

async function testTopicPrompts() {
  console.log('='.repeat(80));
  console.log('测试主题专属 Prompt 提取效果');
  console.log('='.repeat(80) + '\n');

  await initProviders();
  switchProvider('minimax');
  setModelOverride('MiniMax-M2.5-highspeed');

  const testTopics = [
    { name: 'FIX协议对接', keywords: ['FIX', 'fix协议'] },
    { name: '费率与限额', keywords: ['佣金', '费率', '融资'] },
    { name: '交易标的范围', keywords: ['标的', '股票', '市场'] },
  ];

  for (const topic of testTopics) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`测试主题: ${topic.name}`);
    console.log('='.repeat(80));

    try {
      const qa = await extractWeworkQA({
        topics: topic.keywords,
        limit: 5,
        verbose: false,
      });

      console.log(`\n✅ 提取成功: ${qa.length} 个 Q&A\n`);

      if (qa.length > 0) {
        console.log('提取示例:');
        qa.slice(0, 2).forEach((q, i) => {
          console.log(`\n${i + 1}. Q: ${q.question}`);
          console.log(`   A: ${q.answer.slice(0, 120)}...`);
          console.log(`   场景: ${q.context || 'N/A'}`);
        });
      } else {
        console.log('❌ 未提取到 Q&A');
      }

      await sleep(3000); // 避免 API 限流
    } catch (err: any) {
      console.log(`❌ 提取失败: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('测试完成');
  console.log('='.repeat(80));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testTopicPrompts().catch(console.error);
