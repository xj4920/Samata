/**
 * 调试 MiniMax 提取失败原因
 */
import 'dotenv/config';
import { fetchWeworkMessages } from '../src/commands/wework.js';
import { getProvider, getModelName, switchProvider, setModelOverride, initProviders } from '../src/llm/provider.js';

async function debugMiniMax() {
  await initProviders();

  // 切换到 MiniMax
  switchProvider('minimax');
  setModelOverride('MiniMax-M2.5-highspeed');

  console.log('使用模型:', getModelName());

  // 获取测试消息
  const messages = await fetchWeworkMessages({
    keyword: 'FIX',
    limit: 20,
  });

  console.log('找到消息数:', messages.length);

  if (messages.length === 0) {
    console.log('❌ 没有找到消息');
    return;
  }

  // 构造简化的测试 prompt
  const conversationText = messages.slice(0, 10)
    .map(m => `[${m.time}] ${m.sender}: ${m.content}`)
    .join('\n');

  const prompt = `你是一个业务知识提取专家。请从以下企业微信聊天记录中提取关于"FIX协议对接"主题的高质量 Q&A 对。

聊天记录：
${conversationText}

请以 JSON 数组格式返回，每个元素包含：
- question: 问题内容
- answer: 答案内容
- time: 问题提出的时间
- questioner: 提问人真实姓名
- answerer: 回答人真实姓名

只返回 JSON 数组，不要其他说明文字。如果没有符合标准的 Q&A，返回空数组 []。`;

  console.log('\n=== 发送的 prompt（前 500 字符）===');
  console.log(prompt.slice(0, 500) + '...\n');

  try {
    const provider = getProvider();
    const response = await provider.createMessage({
      model: getModelName(),
      max_tokens: 8000,
      system: '你是一个业务知识提取专家。请直接返回 JSON 结果。',
      tools: [],
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    console.log('=== MiniMax 原始响应 ===');
    console.log('响应类型:', content.type);

    if (content.type === 'text') {
      console.log('响应长度:', content.text.length, '字符');
      console.log('\n完整响应内容:');
      console.log(content.text);
      console.log('\n=== 尝试解析 JSON ===');

      // 尝试解析
      let jsonText = content.text.trim();

      // 移除 <think> 标签
      const hasThink = jsonText.includes('<think>');
      if (hasThink) {
        console.log('✓ 检测到 <think> 标签，移除中...');
        jsonText = jsonText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }

      // 检查是否有 markdown 代码块
      const hasCodeBlock = jsonText.includes('```');
      if (hasCodeBlock) {
        console.log('✓ 检测到 markdown 代码块');
        const jsonMatch = jsonText.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        if (jsonMatch) {
          console.log('✓ 成功提取 JSON 代码块');
          jsonText = jsonMatch[1];
        } else {
          console.log('❌ 无法提取 JSON 代码块');
        }
      }

      console.log('\n处理后的 JSON 文本（前 500 字符）:');
      console.log(jsonText.slice(0, 500));

      try {
        const parsed = JSON.parse(jsonText);
        console.log('\n✅ JSON 解析成功！');
        console.log('提取数量:', parsed.length);

        if (parsed.length > 0) {
          console.log('\n第一个 Q&A:');
          console.log(JSON.stringify(parsed[0], null, 2));
        }
      } catch (e: any) {
        console.log('\n❌ JSON 解析失败:', e.message);
        console.log('\n尝试查找 JSON 数组...');

        // 尝试更宽松的匹配
        const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          console.log('找到数组结构，尝试解析...');
          try {
            const parsed2 = JSON.parse(arrayMatch[0]);
            console.log('✅ 宽松解析成功！提取数量:', parsed2.length);
          } catch (e2: any) {
            console.log('❌ 宽松解析也失败:', e2.message);
          }
        }
      }
    }
  } catch (err: any) {
    console.error('\n❌ API 调用失败:', err.message);
    console.error('错误详情:', err);
  }
}

debugMiniMax().catch(console.error);
