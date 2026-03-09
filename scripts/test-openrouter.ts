/**
 * 测试 OpenRouter GLM-5 连接
 */
import 'dotenv/config';
import { initProviders, switchProvider, setModelOverride, getProvider } from '../src/llm/provider.js';

async function testOpenRouter() {
  console.log('测试 OpenRouter GLM-5 连接...\n');

  await initProviders();

  switchProvider('openrouter');
  setModelOverride('z-ai/glm-5');

  console.log('配置信息:');
  console.log('- API Key:', process.env.OPENROUTER_API_KEY?.slice(0, 20) + '...');
  console.log('- Model:', process.env.OPENROUTER_MODEL);
  console.log('- Proxy:', process.env.OPENROUTER_PROXY);

  try {
    console.log('\n发送测试请求...');
    const provider = getProvider();

    const startTime = Date.now();
    const response = await provider.createMessage({
      model: 'z-ai/glm-5',
      max_tokens: 100,
      system: '你是一个助手',
      tools: [],
      messages: [{ role: 'user', content: '请用一句话介绍 FIX 协议' }],
    });

    const elapsed = Date.now() - startTime;

    console.log(`✅ 请求成功！耗时: ${elapsed}ms`);
    console.log('\n响应内容:');
    const content = response.content[0];
    if (content.type === 'text') {
      console.log(content.text);
    }
  } catch (err: any) {
    console.error('❌ 请求失败:', err.message);
    if (err.cause) {
      console.error('原因:', err.cause);
    }
  }
}

testOpenRouter().catch(console.error);
