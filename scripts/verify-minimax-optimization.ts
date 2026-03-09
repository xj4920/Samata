/**
 * 验证优化后的 MiniMax 提取效果
 */
import 'dotenv/config';
import { extractWeworkQA } from '../src/commands/wework-qa.js';
import { initProviders, switchProvider, setModelOverride } from '../src/llm/provider.js';

async function verifyOptimizedPrompt() {
  console.log('使用优化后的 prompt 测试 MiniMax 提取效果...\n');

  await initProviders();
  switchProvider('minimax');
  setModelOverride('MiniMax-M2.5-highspeed');

  const qa = await extractWeworkQA({
    topics: ['FIX', 'fix协议'],
    limit: 10,
    verbose: true,
  });

  console.log('\n=== 提取结果 ===');
  console.log(`提取数量: ${qa.length}`);

  if (qa.length > 0) {
    console.log('\n前 5 个 Q&A:');
    qa.slice(0, 5).forEach((q, i) => {
      console.log(`\n${i+1}. Q: ${q.question}`);
      console.log(`   A: ${q.answer.slice(0, 150)}...`);
      console.log(`   时间: ${q.time}, 提问人: ${q.questioner}, 回答人: ${q.answerer}`);
    });

    console.log('\n=== 总结 ===');
    console.log(`✅ 优化成功！MiniMax 成功提取 ${qa.length} 个 Q&A`);
    console.log('相比优化前（0个），提升显著！');
  } else {
    console.log('❌ 提取失败，仍然是 0 个 Q&A');
  }
}

verifyOptimizedPrompt().catch(console.error);
