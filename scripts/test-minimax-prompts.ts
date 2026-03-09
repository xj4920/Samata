/**
 * 测试不同 prompt 策略对 MiniMax 提取效果的影响
 */
import 'dotenv/config';
import { fetchWeworkMessages, WeworkMessage } from '../src/commands/wework.js';
import { getProvider, switchProvider, setModelOverride, initProviders } from '../src/llm/provider.js';

interface PromptStrategy {
  name: string;
  systemPrompt: string;
  userPrompt: (messages: string, topic: string) => string;
}

const strategies: PromptStrategy[] = [
  {
    name: '策略1：当前默认（保守）',
    systemPrompt: '你是一个业务知识提取专家。请直接返回 JSON 结果。',
    userPrompt: (messages, topic) => `你是一个业务知识提取专家。请从以下企业微信聊天记录中提取关于"${topic}"主题的高质量 Q&A 对。

聊天记录：
${messages}

请以 JSON 数组格式返回，每个元素包含：
- question: 问题内容
- answer: 答案内容
- time: 问题提出的时间
- questioner: 提问人真实姓名
- answerer: 回答人真实姓名

只返回 JSON 数组，不要其他说明文字。如果没有符合标准的 Q&A，返回空数组 []。`
  },
  {
    name: '策略2：明确推理指令',
    systemPrompt: '你是一个业务知识提取专家。请直接返回 JSON 结果，不要使用 <think> 标签。',
    userPrompt: (messages, topic) => `你是一个业务知识提取专家。请从以下企业微信聊天记录中提取关于"${topic}"主题的高质量 Q&A 对。

**提取策略（重要）：**
1. **问题识别**：寻找包含疑问、请求帮助、报错求助的消息
2. **答案推理**：答案可能在后续消息中，需要综合多条消息
3. **隐含问答**：技术讨论、问题解决过程也是有价值的 Q&A
4. **不要过滤**：即使问答不在同一条消息，也要提取

**示例：**
- 消息1: "登录失败，是不是缺了账号信息？" → 这是问题
- 消息2: "需要在 tag553/554 中配置用户ID和密码" → 这是答案
- 提取为：Q: FIX登录失败如何处理？ A: 需要在tag553/554中配置...

聊天记录：
${messages}

请以 JSON 数组格式返回，每个元素包含：
- question: 问题内容（提炼为通用问题）
- answer: 答案内容（综合多条消息的回答）
- time: 问题提出的时间
- questioner: 提问人真实姓名
- answerer: 回答人真实姓名（如果多人回答，用逗号分隔）

只返回 JSON 数组，不要其他说明文字。`
  },
  {
    name: '策略3：降低标准 + 示例引导',
    systemPrompt: '你是一个业务知识提取专家。请直接返回 JSON 结果。',
    userPrompt: (messages, topic) => `你是一个业务知识提取专家。请从以下企业微信聊天记录中提取关于"${topic}"主题的 Q&A 对。

**提取原则：**
✅ 宁可多提取，不要漏掉有价值的内容
✅ 问题和答案可以在不同消息中
✅ 技术讨论、错误排查过程都是有价值的知识
✅ 即使答案不完整，也可以提取（标注为部分答案）

**提取示例：**

原始对话：
[2024-01-01 10:00] 张三: FIX登录报错，提示缺少账号信息
[2024-01-01 10:05] 李四: 检查一下 tag553 和 tag554 是否配置了
[2024-01-01 10:10] 张三: 好的，我看看

提取结果：
{
  "question": "FIX登录报错提示缺少账号信息如何处理？",
  "answer": "需要检查 tag553 和 tag554 字段是否正确配置了用户ID和密码",
  "time": "2024-01-01 10:00",
  "questioner": "张三",
  "answerer": "李四"
}

聊天记录：
${messages}

请以 JSON 数组格式返回，每个元素包含：
- question: 问题内容
- answer: 答案内容
- time: 问题提出的时间
- questioner: 提问人真实姓名
- answerer: 回答人真实姓名

只返回 JSON 数组。`
  },
  {
    name: '策略4：分步引导',
    systemPrompt: '你是一个业务知识提取专家。请按步骤思考，但最终只返回 JSON 结果。',
    userPrompt: (messages, topic) => `请从以下企业微信聊天记录中提取关于"${topic}"主题的 Q&A 对。

**第一步：识别问题**
找出所有包含以下特征的消息：
- 疑问句（如何、为什么、怎么办）
- 报错信息
- 请求帮助（@某人、求助）
- 技术讨论中的疑问点

**第二步：寻找答案**
在问题消息的后续对话中寻找：
- 直接回答
- 解决方案
- 技术说明
- 配置方法

**第三步：综合提取**
将问题和答案组合成完整的 Q&A 对，即使它们不在同一条消息中。

聊天记录：
${messages}

请以 JSON 数组格式返回，每个元素包含：
- question: 问题内容（提炼为通用问题）
- answer: 答案内容（综合多条消息）
- time: 问题提出的时间
- questioner: 提问人真实姓名
- answerer: 回答人真实姓名（多人回答用逗号分隔）

只返回 JSON 数组。`
  }
];

async function testPromptStrategies() {
  console.log('='.repeat(80));
  console.log('MiniMax Prompt 策略测试');
  console.log('='.repeat(80) + '\n');

  await initProviders();
  switchProvider('minimax');
  setModelOverride('MiniMax-M2.5-highspeed');

  // 获取测试消息
  const messages = await fetchWeworkMessages({
    keyword: 'FIX',
    limit: 50,
  });

  console.log(`找到 ${messages.length} 条消息\n`);

  if (messages.length === 0) {
    console.log('❌ 没有找到测试消息');
    return;
  }

  // 使用前 20 条消息测试
  const testMessages = messages.slice(0, 20);
  const conversationText = testMessages
    .map(m => `[${m.time}] ${m.sender}: ${m.content}`)
    .join('\n');

  console.log('测试消息预览（前 3 条）:');
  testMessages.slice(0, 3).forEach(m => {
    console.log(`  [${m.time}] ${m.sender}: ${m.content.slice(0, 80)}...`);
  });
  console.log('\n' + '='.repeat(80) + '\n');

  const provider = getProvider();
  const results: Array<{ strategy: string; count: number; time: number; qas: any[] }> = [];

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    console.log(`测试 ${strategy.name}...`);

    try {
      const startTime = Date.now();
      const response = await provider.createMessage({
        model: 'MiniMax-M2.5-highspeed',
        max_tokens: 8000,
        system: strategy.systemPrompt,
        tools: [],
        messages: [{
          role: 'user',
          content: strategy.userPrompt(conversationText, 'FIX协议对接')
        }],
      });

      const elapsed = Date.now() - startTime;
      const content = response.content[0];

      if (content.type === 'text') {
        // 解析 JSON
        let jsonText = content.text.trim();
        jsonText = jsonText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        const jsonMatch = jsonText.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        if (jsonMatch) {
          jsonText = jsonMatch[1];
        }

        try {
          const qas = JSON.parse(jsonText);
          results.push({
            strategy: strategy.name,
            count: qas.length,
            time: elapsed,
            qas: qas
          });

          console.log(`  ✅ 成功提取 ${qas.length} 个 Q&A，耗时 ${elapsed}ms`);

          if (qas.length > 0) {
            console.log(`  示例 Q&A:`);
            console.log(`    Q: ${qas[0].question.slice(0, 60)}...`);
            console.log(`    A: ${qas[0].answer.slice(0, 60)}...`);
          }
        } catch (e: any) {
          console.log(`  ❌ JSON 解析失败: ${e.message}`);
          results.push({
            strategy: strategy.name,
            count: 0,
            time: elapsed,
            qas: []
          });
        }
      }
    } catch (err: any) {
      console.log(`  ❌ API 调用失败: ${err.message}`);
      results.push({
        strategy: strategy.name,
        count: 0,
        time: 0,
        qas: []
      });
    }

    console.log('');
    await sleep(3000); // 避免 API 限流
  }

  // 生成对比报告
  console.log('='.repeat(80));
  console.log('测试结果汇总');
  console.log('='.repeat(80));
  console.log('\n| 策略 | 提取数量 | 耗时(ms) | 状态 |');
  console.log('|------|---------|---------|------|');

  results.forEach(r => {
    const status = r.count > 0 ? '✅' : '❌';
    console.log(`| ${r.strategy} | ${r.count} | ${r.time} | ${status} |`);
  });

  // 找出最佳策略
  const best = results.reduce((prev, curr) =>
    curr.count > prev.count ? curr : prev
  );

  console.log('\n' + '='.repeat(80));
  console.log(`🏆 最佳策略: ${best.strategy}`);
  console.log(`   提取数量: ${best.count} 个 Q&A`);
  console.log('='.repeat(80));

  if (best.count > 0) {
    console.log('\n提取的 Q&A 示例:');
    best.qas.slice(0, 3).forEach((qa, i) => {
      console.log(`\n${i + 1}. Q: ${qa.question}`);
      console.log(`   A: ${qa.answer.slice(0, 100)}...`);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testPromptStrategies().catch(console.error);
