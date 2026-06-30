import type { LLMProvider, StreamEvent } from './provider.js';
import { convertTools, convertMessages, convertResponse, parseSSEStream } from './openai-compat.js';

/* ----------------------------------------------------------------
 * Custom Provider factory
 * OpenAI-compatible chat/completions gateway configured by environment.
 *
 * Required:
 *   - CUSTOM_API_KEY
 *
 * Optional:
 *   - CUSTOM_BASE_URL     Defaults to https://api.openai.com/v1
 *   - CUSTOM_MODEL        Defaults to custom-model
 *   - CUSTOM_VISION_MODEL Defaults to CUSTOM_MODEL
 *   - CUSTOM_MODELS       Comma-separated model allowlist for /model listing
 * ---------------------------------------------------------------- */

function parseAvailableModels(): string[] | undefined {
  const raw = process.env.CUSTOM_MODELS;
  if (!raw) return undefined;
  const models = raw.split(',').map(m => m.trim()).filter(Boolean);
  return models.length > 0 ? models : undefined;
}

export function createCustomProvider(): LLMProvider | null {
  const apiKey = process.env.CUSTOM_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.CUSTOM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const defaultModel = process.env.CUSTOM_MODEL || 'custom-model';
  const visionModel = process.env.CUSTOM_VISION_MODEL || defaultModel;
  const availableModels = parseAvailableModels();

  return {
    name: 'custom',
    defaultModel,
    availableModels,

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
        throw new Error(`Custom Vision ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();
      if (data.error) throw new Error(`Custom Vision error: ${JSON.stringify(data.error)}`);
      return data.choices?.[0]?.message?.content ?? '';
    },

    async createMessage(params, options) {
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
        signal: options?.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Custom API ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();

      if (data.error) {
        throw new Error(`Custom error: ${JSON.stringify(data.error)}`);
      }

      return convertResponse(data, 'Custom');
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

      const res = await fetch(`${baseUrl}/chat/completions`, {
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
        throw new Error(`Custom API ${res.status}: ${text.slice(0, 500)}`);
      }

      if (!res.body) throw new Error('Custom stream: no response body');

      yield* parseSSEStream(res.body as AsyncIterable<Uint8Array>, 'Custom');
    },
  };
}
