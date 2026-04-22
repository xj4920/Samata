/**
 * Session summarizer — extracts a one-line summary and user preferences
 * from conversation history, then updates the workspace md file.
 *
 * Uses the 'summary' task type so it can be routed to a lightweight model
 * via MODEL_SUMMARY / PROVIDER_SUMMARY env vars.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { getProviderForTask, getModelForTask } from '../llm/provider.js';
import { updateWorkspace } from './workspace.js';
import { log } from '../utils/logger.js';

const MIN_HISTORY_LENGTH = 8; // at least 4 turns (user+assistant each)

/**
 * Extract plain text from an Anthropic MessageParam array.
 * Skips tool_use / tool_result blocks, keeps only human-readable text.
 */
function extractText(history: Anthropic.MessageParam[]): string {
  const lines: string[] = [];
  for (const msg of history) {
    const role = msg.role === 'user' ? '用户' : '助手';
    if (typeof msg.content === 'string') {
      lines.push(`${role}: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          lines.push(`${role}: ${block.text}`);
        }
      }
    }
  }
  return lines.join('\n');
}

const SUMMARIZE_PROMPT = `请根据以下对话记录，生成 JSON（不要包含 markdown code fence）：
{
  "summary": "本次对话摘要，一句话，不超过30字",
  "preferences": ["新发现的用户偏好或习惯（如有）"]
}

规则：
- summary 必须是对话主题的高度浓缩
- preferences 只记录新发现的、有长期价值的用户偏好，没有则给空数组
- 不要记录一次性的事实查询作为偏好

对话记录：
`;

interface SummarizeResult {
  summary: string;
  preferences: string[];
}

async function callSummarizer(text: string): Promise<SummarizeResult> {
  const provider = getProviderForTask('summary');
  const model = getModelForTask('summary');

  const result = await provider.createMessage({
    model,
    max_tokens: 256,
    system: '你是一个对话摘要助手，只输出 JSON，不输出其他内容。',
    tools: [],
    messages: [{ role: 'user', content: SUMMARIZE_PROMPT + text }],
  });

  const raw = result.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  try {
    const cleaned = raw.replace(/```json\s*|```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned) as SummarizeResult;
    return {
      summary: parsed.summary || '（无摘要）',
      preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
    };
  } catch {
    log.warn(`[Workspace] 摘要 JSON 解析失败，原始输出: ${raw.slice(0, 200)}`);
    return { summary: raw.slice(0, 30), preferences: [] };
  }
}

/**
 * Summarize a completed session and update the user's workspace file.
 * Silently skips if history is too short.
 * Fire-and-forget safe — errors are logged, never thrown.
 */
export async function summarizeAndUpdateWorkspace(
  agentName: string,
  userId: string,
  history: Anthropic.MessageParam[],
): Promise<void> {
  if (history.length < MIN_HISTORY_LENGTH) return;

  try {
    const text = extractText(history);
    if (!text.trim()) return;

    // Cap input to avoid blowing up token budget on the summary model
    const truncated = text.length > 4000 ? text.slice(-4000) : text;

    const { summary, preferences } = await callSummarizer(truncated);
    updateWorkspace(agentName, userId, summary, preferences);
    log.dim(`[Workspace] 已更新 ${agentName}/${userId}: ${summary}`);
  } catch (err: any) {
    log.warn(`[Workspace] 摘要失败 (${agentName}/${userId}): ${err.message}`);
  }
}
