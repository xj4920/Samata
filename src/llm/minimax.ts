import { Agent } from 'undici';
import type { LLMProvider, StreamEvent } from './provider.js';
import { convertTools, convertMessages, convertResponse, parseSSEStream } from './openai-compat.js';

/* ----------------------------------------------------------------
 * Provider 工厂
 * ---------------------------------------------------------------- */

// MiniMax 有两个 ALB 节点，偶尔一个不可达。
// 使用短 connectTimeout 快速失败，fetchWithRetry 最多重试 2 次，
// 每次重试创建新 Agent 以强制 DNS 重新解析，规避坏节点。
function makeMinimaxAgent() {
  return new Agent({
    connect: { timeout: 8000 },
    bodyTimeout: 120000,
    headersTimeout: 30000,
  });
}

async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 2): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    const agent = makeMinimaxAgent();
    try {
      return await fetch(url, { ...init, dispatcher: agent } as any);
    } catch (e: any) {
      lastErr = e;
      const isTimeout = e?.cause?.message?.includes('Connect Timeout') ||
                        e?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
      if (!isTimeout || i === maxRetries) throw e;
    }
  }
  throw lastErr;
}

export function createMinimaxProvider(): LLMProvider | null {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1').replace(/\/+$/, '');
  const defaultModel = process.env.MINIMAX_MODEL || 'MiniMax-Text-01';

  return {
    name: 'minimax',
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

      const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`MiniMax API ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();

      // MiniMax 某些错误以 200 返回但带 error 字段
      if (data.error) {
        throw new Error(`MiniMax error: ${JSON.stringify(data.error)}`);
      }

      return convertResponse(data, 'MiniMax');
    },

    async describeImage(imageDataUrl: string, prompt: string): Promise<string> {
      const vlmUrl = process.env.MINIMAX_VLM_URL;
      if (!vlmUrl) throw new Error('MINIMAX_VLM_URL 未配置');
      const res = await fetchWithRetry(vlmUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ prompt, image_url: imageDataUrl }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`MiniMax VLM ${res.status}: ${text.slice(0, 500)}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(`MiniMax VLM error: ${JSON.stringify(data.error)}`);
      return data.reply ?? data.choices?.[0]?.message?.content ?? JSON.stringify(data);
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

      const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`MiniMax API ${res.status}: ${text.slice(0, 500)}`);
      }

      if (!res.body) throw new Error('MiniMax stream: no response body');

      yield* parseSSEStream(res.body as AsyncIterable<Uint8Array>, 'MiniMax');
    },
  };
}
