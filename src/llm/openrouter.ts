import { ProxyAgent } from 'undici';
import type { LLMProvider, StreamEvent } from './provider.js';
import { convertTools, convertMessages, convertResponse, parseSSEStream } from './openai-compat.js';

/* ----------------------------------------------------------------
 * OpenRouter Provider 工厂
 * https://openrouter.ai/docs/quickstart
 * ---------------------------------------------------------------- */

export function createOpenRouterProvider(): LLMProvider | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const defaultModel = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';

  // 代理支持: OPENROUTER_PROXY=http://127.0.0.1:26001
  const proxyUrl = process.env.OPENROUTER_PROXY;
  const fetchOptions: Record<string, unknown> = {};
  if (proxyUrl) {
    fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
  }

  return {
    name: 'openrouter',
    defaultModel,
    async createMessage(params) {
      const body: Record<string, unknown> = {
        model: params.model,
        max_tokens: params.max_tokens,
        messages: convertMessages(params.system, params.messages),
      };

      if (params.tools.length > 0) {
        body.tools = convertTools(params.tools);
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        ...fetchOptions,
      } as any);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter API ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();

      if (data.error) {
        throw new Error(`OpenRouter error: ${JSON.stringify(data.error)}`);
      }

      return convertResponse(data, 'OpenRouter');
    },

    async *createMessageStream(params): AsyncGenerator<StreamEvent> {
      const body: Record<string, unknown> = {
        model: params.model,
        max_tokens: params.max_tokens,
        messages: convertMessages(params.system, params.messages),
        stream: true,
      };

      if (params.tools.length > 0) {
        body.tools = convertTools(params.tools);
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        ...fetchOptions,
      } as any);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter API ${res.status}: ${text.slice(0, 500)}`);
      }

      if (!res.body) throw new Error('OpenRouter stream: no response body');

      yield* parseSSEStream(res.body as AsyncIterable<Uint8Array>, 'OpenRouter');
    },
  };
}
