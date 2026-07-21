import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { LLMProvider } from '../llm/provider.js';
import { parseLLMJsonObject } from '../utils/json-repair.js';
import type { JudgeResult, ScenarioCase, ScenarioExecutionResult } from './types.js';

interface RawJudgeOutput {
  score?: unknown;
  passed?: unknown;
  rationale?: unknown;
}

function resultText(content: Awaited<ReturnType<LLMProvider['createMessage']>>['content']): string {
  return content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n');
}

function evidence(execution: ScenarioExecutionResult): unknown {
  return execution.toolCalls.map(call => ({
    tool: call.tool,
    input: call.input,
    output: call.output.slice(0, 4000),
    success: call.success,
    error: call.error,
  }));
}

export async function judgeScenarioAnswer(
  provider: LLMProvider,
  model: string,
  scenarioCase: ScenarioCase,
  execution: ScenarioExecutionResult,
): Promise<JudgeResult> {
  if (!scenarioCase.judge.enabled) return { status: 'passed' };

  const system = readFileSync(resolve(process.cwd(), 'evals/prompts/judge-answer.md'), 'utf8');
  const input = {
    user_request: scenarioCase.input.text,
    frozen_evidence: evidence(execution),
    answer: execution.answer,
    criteria: scenarioCase.judge.criteria,
    reference_answer: scenarioCase.judge.referenceAnswer,
    minimum_score: scenarioCase.judge.minScore,
  };

  try {
    const response = await provider.createMessage({
      model,
      max_tokens: 800,
      system,
      tools: [],
      messages: [{ role: 'user', content: JSON.stringify(input) }],
    });
    const parsed = parseLLMJsonObject<RawJudgeOutput>(resultText(response.content));
    if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 1) {
      throw new Error('Judge score 必须在 0 到 1 之间');
    }
    const minScore = scenarioCase.judge.minScore ?? 0;
    const passed = parsed.passed === true && parsed.score >= minScore;
    return {
      status: passed ? 'passed' : 'failed',
      score: parsed.score,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
      model,
    };
  } catch (error) {
    return {
      status: 'inconclusive',
      model,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
