import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProxyAgent } from 'undici';
import type { LLMProvider, StreamEvent } from './provider.js';
import { convertTools, convertMessages } from './openai-compat.js';

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
 * Provider 工厂 — 使用 Google 原生协议 (HTTP) 调用 Gemini，支持绕过网关 WAF
 * ---------------------------------------------------------------- */

export function createGeminiProvider(): LLMProvider | null {
  const geminiEnv = loadGeminiEnv();

  const apiKey = process.env.GEMINI_API_KEY || geminiEnv.GEMINI_API_KEY;
  if (!apiKey) return null;

  // 获取基础 URL，移除末尾多余的 /v1
  const rawBaseURL = process.env.GEMINI_BASE_URL || process.env.GOOGLE_GEMINI_BASE_URL || geminiEnv.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  let baseURL = rawBaseURL.replace(/\/+$/, '');
  if (baseURL.endsWith('/v1')) {
      baseURL = baseURL.slice(0, -3);
  }

  const defaultModel = process.env.GEMINI_MODEL || geminiEnv.GEMINI_MODEL || 'gemini-2.0-flash';

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const fetchOptions: Record<string, unknown> = {};
  if (proxyUrl) {
    fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
  }

  // 伪装浏览器 UA 防止中转站拦截
  const defaultHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Encoding': 'identity'
  };

  // 工具函数：将内部消息格式转为 Google Gemini 原生格式
  function convertToGeminiFormat(systemPrompt: string | undefined, messages: any[]) {
      // 复用 openai-compat.js 将内容标准化，然后再转为 Google 格式
      const oaiMessages = convertMessages(systemPrompt || '', messages);
      const contents = [];
      let systemInstruction = undefined;

      for (const msg of oaiMessages) {
          if (msg.role === 'system') {
               // Gemini system prompt
               systemInstruction = { parts: [{ text: msg.content }] };
          } else if (msg.role === 'user' || msg.role === 'assistant') {
               const role = msg.role === 'assistant' ? 'model' : 'user';
               let parts = [];
               
               if (typeof msg.content === 'string') {
                   parts.push({ text: msg.content });
               } else if (Array.isArray(msg.content)) {
                   for (const part of msg.content) {
                       if (part.type === 'text') {
                           parts.push({ text: part.text });
                       } else if (part.type === 'image_url' && part.image_url) {
                           // 提取 base64 (假设格式为 data:image/png;base64,...)
                           const b64Data = part.image_url.url.split(',')[1];
                           const mimeType = part.image_url.url.split(';')[0].split(':')[1];
                           parts.push({
                               inline_data: {
                                   mime_type: mimeType || 'image/jpeg',
                                   data: b64Data
                               }
                           });
                       }
                   }
               }
               contents.push({ role, parts });
          }
      }
      
      return { contents, systemInstruction };
  }


  return {
    name: 'gemini',
    defaultModel,
    async createMessage(params) {
      
      const { contents, systemInstruction } = convertToGeminiFormat(params.system, params.messages);
      
      const body: any = { contents };
      if (systemInstruction) {
          body.systemInstruction = systemInstruction;
      }
      
      // Generation Config
      if (params.max_tokens) {
          body.generationConfig = { maxOutputTokens: params.max_tokens };
      }

      // TODO: 原生工具支持 (如果有需要可以在此适配)
      
      const url = `${baseURL}/v1beta/models/${params.model || defaultModel}:generateContent?key=${apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify(body),
        ...fetchOptions,
      } as any);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini API Error ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();
      
      if (!data.candidates || data.candidates.length === 0) {
          throw new Error(`Gemini API returned empty candidates: ${JSON.stringify(data)}`);
      }

      const textOutput = data.candidates[0].content?.parts?.[0]?.text || '';

      const usage = data.usageMetadata
        ? { input_tokens: data.usageMetadata.promptTokenCount ?? 0, output_tokens: data.usageMetadata.candidatesTokenCount ?? 0 }
        : undefined;

      return {
          content: [{ type: 'text', text: textOutput, citations: null } as any],
          stop_reason: 'end_turn',
          usage,
      };
    },

    async *createMessageStream(params): AsyncGenerator<StreamEvent> {
      const { contents, systemInstruction } = convertToGeminiFormat(params.system, params.messages);
      
      const body: any = { contents };
      if (systemInstruction) {
          body.systemInstruction = systemInstruction;
      }
      if (params.max_tokens) {
          body.generationConfig = { maxOutputTokens: params.max_tokens };
      }

      const url = `${baseURL}/v1beta/models/${params.model || defaultModel}:streamGenerateContent?alt=sse&key=${apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify(body),
        ...fetchOptions,
      } as any);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini Stream API Error ${res.status}: ${text.slice(0, 500)}`);
      }

      if (!res.body) throw new Error('Gemini stream: no response body');
      
      // Parse SSE Stream specifically for Google Gemini Format
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const data = JSON.parse(dataStr);
              // Handle top-level errors explicitly
              if (data.error) {
                 throw new Error(data.error.message || JSON.stringify(data.error));
              }
              const textChunk = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (textChunk) {
                  fullText += textChunk;
                  yield { type: 'text_delta', text: textChunk };
              }
            } catch (e) {
              if (e instanceof SyntaxError) {
                  // Ignore parse errors on partial chunks
              } else {
                  throw e;
              }
            }
          }
        }
      }
      yield { type: 'done', content: [{ type: 'text', text: fullText, citations: null } as any], stop_reason: 'end_turn', usage: undefined };
    },
  };
}