import { getProviderForTask, getModelForTask } from '../llm/provider.js';
import { log } from './logger.js';
import type { QAPair } from '../commands/wework-qa.js';

export interface QualityScore {
  score: number; // 1-5
  reason: string;
  model: string;
}

/**
 * 使用 LLM 评估 Q&A 质量
 */
export async function scoreQAQuality(qa: QAPair): Promise<QualityScore> {
  const prompt = `评估以下 Q&A 的质量（1-5分）：

评分标准：
5分：问题清晰具体，答案完整可操作，具有普适性，可直接用于知识库
4分：问题和答案都不错，但可能需要小幅优化
3分：基本合格，但问题或答案有明显不足
2分：质量较差，需要大幅修改
1分：不符合知识库标准，建议拒绝

Q: ${qa.question}

A: ${qa.answer}

请返回 JSON 格式：{"score": 4, "reason": "问题清晰，答案详细且具有普适性"}`;

  try {
    const provider = getProviderForTask('scoring');
    const model = getModelForTask('scoring');

    const response = await provider.createMessage({
      model,
      max_tokens: 300,
      system: '你是一个知识库质量评估专家。请直接返回 JSON 结果，不要其他说明。',
      tools: [],
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      return { score: 3, reason: '评分失败', model };
    }

    // 提取 JSON（可能包含在 markdown 代码块中）
    let jsonText = content.text.trim();
    jsonText = jsonText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    const jsonMatch = jsonText.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        score: Math.max(1, Math.min(5, result.score)), // 限制在 1-5
        reason: result.reason || '',
        model,
      };
    }

    return { score: 3, reason: '解析失败', model };
  } catch (err: any) {
    log.error(`质量评分失败: ${err.message}`);
    return { score: 3, reason: `评分异常: ${err.message}`, model: 'error' };
  }
}

/**
 * 批量评分
 */
export async function batchScoreQA(qaPairs: QAPair[]): Promise<Map<string, QualityScore>> {
  const scores = new Map<string, QualityScore>();

  for (let i = 0; i < qaPairs.length; i++) {
    const qa = qaPairs[i];
    log.dim(`  评分进度: ${i + 1}/${qaPairs.length}`);

    const score = await scoreQAQuality(qa);
    const key = `${qa.time}-${qa.questioner}`;
    scores.set(key, score);

    // 避免 API 限流
    await sleep(1000);
  }

  return scores;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
