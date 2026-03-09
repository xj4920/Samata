import { initProviders, getAvailableProviders, getProviderName, getModelName } from '../src/llm/provider.js';
import { createMinimaxProvider } from '../src/llm/minimax.js';

async function testProviders() {
  console.log('测试 LLM Providers 初始化...\n');

  // 检查环境变量
  console.log('环境变量检查:');
  console.log('  MINIMAX_API_KEY:', process.env.MINIMAX_API_KEY ? `存在 (${process.env.MINIMAX_API_KEY.length} 字符)` : '缺失');
  console.log('  MINIMAX_MODEL:', process.env.MINIMAX_MODEL || '缺失');
  console.log('  MINIMAX_BASE_URL:', process.env.MINIMAX_BASE_URL || '缺失');
  console.log('  LLM_PROVIDER:', process.env.LLM_PROVIDER || '缺失');
  console.log();

  // 测试直接创建 MiniMax provider
  console.log('直接创建 MiniMax provider:');
  const minimaxProvider = createMinimaxProvider();
  console.log('  结果:', minimaxProvider ? '成功' : '失败');
  if (minimaxProvider) {
    console.log('  名称:', minimaxProvider.name);
    console.log('  默认模型:', minimaxProvider.defaultModel);
  }
  console.log();

  // 测试 initProviders
  console.log('通过 initProviders 初始化:');
  const success = await initProviders();

  console.log('  初始化结果:', success ? '成功' : '失败');
  console.log('  可用 providers:', getAvailableProviders());
  console.log('  当前 provider:', getProviderName());
  console.log('  当前 model:', getModelName());
}

testProviders().catch(console.error);
