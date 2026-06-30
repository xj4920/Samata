import type { LLMProvider, StreamEvent } from './provider.js';
import { convertTools, convertMessages, convertResponse, parseSSEStream } from './openai-compat.js';

/* ----------------------------------------------------------------
 * DeepSeek Provider 工厂
 * DeepSeek 官方 API（OpenAI 协议兼容）
 * Base URL: https://api.deepseek.com
 * 可选模型:
 *   - deepseek-v4-flash
 *   - deepseek-v4-pro
 * ---------------------------------------------------------------- */

export const DEEPSEEK_AVAILABLE_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
];

export function createDeepseekProvider(): LLMProvider | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

  return {
    name: 'deepseek',
    defaultModel,
    availableModels: DEEPSEEK_AVAILABLE_MODELS,

    async createMessage(params, options) {
      const body: Record<string, unknown> = {
        model: params.model,
        max_tokens: params.max_tokens,
        messages: convertMessages(params.system, params.messages),
      };

      if (params.tools.length > 0) {
        body.tools = convertTools(params.tools);
      }

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`DeepSeek API ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();

      if (data.error) {
        throw new Error(`DeepSeek error: ${JSON.stringify(data.error)}`);
      }

      return convertResponse(data, 'DeepSeek');
    },

    async *createMessageStream(params, options): AsyncGenerator<StreamEvent> {
      const body: Record<string, unknown> = {
        model: params.model,
        max_tokens: params.max_tokens,
        messages: convertMessages(params.system, params.messages),
        stream: true,
      };

      if (params.tools.length > 0) {
        body.tools = convertTools(params.tools);
      }

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`DeepSeek API ${res.status}: ${text.slice(0, 500)}`);
      }

      if (!res.body) throw new Error('DeepSeek stream: no response body');

      yield* parseSSEStream(res.body as AsyncIterable<Uint8Array>, 'DeepSeek');
    },
  };
}
