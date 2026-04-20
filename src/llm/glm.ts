import type { LLMProvider, StreamEvent } from './provider.js';
import { convertTools, convertMessages, convertResponse, parseSSEStream } from './openai-compat.js';

/* ----------------------------------------------------------------
 * GLM Provider 工厂
 * 使用 OpenAI 协议兼容 API
 * Base URL: http://llm.smart-zone-dev.gf.com.cn/api/oai/v1
 * 文本模型: external-glm-5-turbo
 * 视觉模型: external-glm-4.5v
 * ---------------------------------------------------------------- */

export function createGlmProvider(): LLMProvider | null {
  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.GLM_BASE_URL || 'http://llm.smart-zone-dev.gf.com.cn/api/oai/v1').replace(/\/+$/, '');
  const defaultModel = process.env.GLM_MODEL || 'external-glm-5-turbo';
  const visionModel = process.env.GLM_VISION_MODEL || 'external-glm-4.5v';

  return {
    name: 'glm',
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
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GLM API ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();

      if (data.error) {
        throw new Error(`GLM error: ${JSON.stringify(data.error)}`);
      }

      return convertResponse(data, 'GLM');
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
        throw new Error(`GLM API ${res.status}: ${text.slice(0, 500)}`);
      }

      if (!res.body) throw new Error('GLM stream: no response body');

      yield* parseSSEStream(res.body as AsyncIterable<Uint8Array>, 'GLM');
    },

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
              { type: 'text', text: prompt || '请详细描述这张图片的内容' },
              { type: 'image_url', image_url: { url: imageDataUrl } }
            ]
          }]
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GLM Vision API ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();

      if (data.error) {
        throw new Error(`GLM Vision error: ${JSON.stringify(data.error)}`);
      }

      return data.choices?.[0]?.message?.content || '';
    },
  };
}