import type { LLMProvider, StreamEvent } from './provider.js';
import { convertTools, convertMessages, convertResponse, parseSSEStream } from './openai-compat.js';

/* ----------------------------------------------------------------
 * GF Provider 工厂
 * 广发内部 LLM 网关（OpenAI 协议兼容）
 * Base URL: http://llm.smart-zone-dev.gf.com.cn/api/oai/v1
 * 可选模型:
 *   - external-glm-5-turbo
 *   - external-glm-5.1
 *   - external-deepseek-v4-pro
 *   - external-deepseek-v4-flash
 *   - external-kimi-k2.6
 * ---------------------------------------------------------------- */

export const GF_AVAILABLE_MODELS = [
  'external-glm-5-turbo',
  'external-glm-5.1',
  'external-deepseek-v4-pro',
  'external-deepseek-v4-flash',
  'external-kimi-k2.6',
];

export function createGfProvider(): LLMProvider | null {
  const apiKey = process.env.GF_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.GF_BASE_URL || 'http://llm.smart-zone-dev.gf.com.cn/api/oai/v1').replace(/\/+$/, '');
  const defaultModel = process.env.GF_MODEL || 'external-glm-5-turbo';
  const visionModel = process.env.GF_VISION_MODEL || 'external-kimi-k2.6';

  return {
    name: 'gf',
    defaultModel,
    availableModels: GF_AVAILABLE_MODELS,

    async describeImage(imageDataUrl: string, prompt: string): Promise<string> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: visionModel,
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageDataUrl } },
              { type: 'text', text: prompt || '请详细描述这张图片的内容' },
            ],
          }],
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GF Vision ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();
      if (data.error) throw new Error(`GF Vision error: ${JSON.stringify(data.error)}`);
      return data.choices?.[0]?.message?.content ?? '';
    },

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
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GF API ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();

      if (data.error) {
        throw new Error(`GF error: ${JSON.stringify(data.error)}`);
      }

      return convertResponse(data, 'GF');
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
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GF API ${res.status}: ${text.slice(0, 500)}`);
      }

      if (!res.body) throw new Error('GF stream: no response body');

      yield* parseSSEStream(res.body as AsyncIterable<Uint8Array>, 'GF');
    },
  };
}
