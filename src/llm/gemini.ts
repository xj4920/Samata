import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, StreamEvent } from './provider.js';

/* ----------------------------------------------------------------
 * 从 ~/.gemini/.env 读取 Gemini 配置
 * ---------------------------------------------------------------- */

function loadGeminiEnv(): Record<string, string> {
  const envPath = join(homedir(), '.gemini', '.env');
  try {
    const text = readFileSync(envPath, 'utf-8');
    const vars: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

/* ----------------------------------------------------------------
 * Provider 工厂 — 复用 Anthropic SDK，通过兼容网关调用 Gemini
 * ---------------------------------------------------------------- */

export function createGeminiProvider(): LLMProvider | null {
  const geminiEnv = loadGeminiEnv();

  // 优先用项目 .env，fallback 到 ~/.gemini/.env
  const apiKey = process.env.GEMINI_API_KEY || geminiEnv.GEMINI_API_KEY;
  if (!apiKey) return null;

  const baseURL = process.env.GEMINI_BASE_URL || geminiEnv.GOOGLE_GEMINI_BASE_URL;
  if (!baseURL) return null;

  const defaultModel = process.env.GEMINI_MODEL || geminiEnv.GEMINI_MODEL || 'gemini-2.0-flash';

  const client = new Anthropic({ apiKey, baseURL });

  return {
    name: 'gemini',
    defaultModel,
    async createMessage(params) {
      const resp = await client.messages.create(params);
      return {
        content: resp.content,
        stop_reason: resp.stop_reason ?? 'end_turn',
      };
    },
    async *createMessageStream(params): AsyncGenerator<StreamEvent> {
      const stream = client.messages.stream(params);
      let stopReason = 'end_turn';

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          }
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
