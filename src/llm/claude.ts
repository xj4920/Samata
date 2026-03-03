import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, StreamEvent } from './provider.js';

let client: Anthropic | null = null;

export function initClaude(): boolean {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey || apiKey === 'your-api-key-here') {
    return false;
  }

  const opts: ConstructorParameters<typeof Anthropic>[0] = { apiKey };

  const baseURL = process.env.ANTHROPIC_BASE_URL;
  if (baseURL) {
    opts.baseURL = baseURL;
  }

  client = new Anthropic(opts);
  return true;
}

export function getClaude(): Anthropic {
  if (!client) throw new Error('Claude 未初始化，请检查 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN');
  return client;
}

/** 将已有的 Anthropic client 包装为 LLMProvider */
export function createAnthropicProvider(): LLMProvider | null {
  if (!initClaude()) return null;
  const defaultModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  return {
    name: 'anthropic',
    defaultModel,
    async createMessage(params) {
      const resp = await getClaude().messages.create(params);
      return {
        content: resp.content,
        stop_reason: resp.stop_reason ?? 'end_turn',
      };
    },
    async *createMessageStream(params): AsyncGenerator<StreamEvent> {
      const stream = getClaude().messages.stream(params);
      const content: Anthropic.ContentBlock[] = [];
      let currentText = '';
      let stopReason = 'end_turn';

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'text') {
            currentText = '';
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            currentText += event.delta.text;
            yield { type: 'text_delta', text: event.delta.text };
          }
        } else if (event.type === 'content_block_stop') {
          // block 结束，不做特殊处理，最终结果从 finalMessage 获取
        } else if (event.type === 'message_stop') {
          // 流结束
        } else if (event.type === 'message_delta') {
          if (event.delta.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
        }
      }

      const final = await stream.finalMessage();
      yield { type: 'done', content: final.content, stop_reason: final.stop_reason ?? stopReason };
    },
  };
}
