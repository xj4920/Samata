import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, StreamEvent } from './provider.js';
import { log } from '../utils/logger.js';

/* ----------------------------------------------------------------
 * OpenAI-compatible 类型（MiniMax chat/completions 使用此格式）
 * ---------------------------------------------------------------- */
interface OAITool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/* ----------------------------------------------------------------
 * Anthropic → OpenAI 格式转换
 * ---------------------------------------------------------------- */

function convertTools(tools: Anthropic.Tool[]): OAITool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

function convertMessages(system: string, messages: Anthropic.MessageParam[]): OAIMessage[] {
  const result: OAIMessage[] = [{ role: 'system', content: system }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            result.push({ role: 'user', content: block.text });
          } else if (block.type === 'tool_result') {
            const tb = block as Anthropic.ToolResultBlockParam;
            result.push({
              role: 'tool',
              tool_call_id: tb.tool_use_id,
              content: typeof tb.content === 'string'
                ? tb.content
                : JSON.stringify(tb.content),
            });
          }
        }
      }
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: NonNullable<OAIMessage['tool_calls']> = [];

      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Anthropic.ContentBlock[]) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }
      } else if (typeof msg.content === 'string') {
        textParts.push(msg.content);
      }

      const am: OAIMessage = {
        role: 'assistant',
        content: textParts.join('\n') || null,
      };
      if (toolCalls.length > 0) am.tool_calls = toolCalls;
      result.push(am);
    }
  }

  return result;
}

/* ----------------------------------------------------------------
 * OpenAI 响应 → Anthropic ContentBlock[] + stop_reason
 * ---------------------------------------------------------------- */

function convertResponse(data: any): {
  content: Anthropic.ContentBlock[];
  stop_reason: string;
} {
  const choice = data.choices?.[0];
  if (!choice) throw new Error('MiniMax 返回空 choices');

  const content: Anthropic.ContentBlock[] = [];

  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content } as Anthropic.TextBlock);
  }

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      } as unknown as Anthropic.ToolUseBlock);
    }
  }

  // 空内容兜底
  if (content.length === 0) {
    content.push({ type: 'text', text: '' } as Anthropic.TextBlock);
  }

  const stop_reason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
  return { content, stop_reason };
}

/* ----------------------------------------------------------------
 * Provider 工厂
 * ---------------------------------------------------------------- */

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

      // 只在有 tools 时才传入（有些模型不支持空 tools 数组）
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
        throw new Error(`MiniMax API ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = await res.json();

      // MiniMax 某些错误以 200 返回但带 error 字段
      if (data.error) {
        throw new Error(`MiniMax error: ${JSON.stringify(data.error)}`);
      }

      return convertResponse(data);
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
        throw new Error(`MiniMax API ${res.status}: ${text.slice(0, 500)}`);
      }

      if (!res.body) throw new Error('MiniMax stream: no response body');

      const content: Anthropic.ContentBlock[] = [];
      let fullText = '';
      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

      const decoder = new TextDecoder();
      let buffer = '';

      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') continue;

          let data: any;
          try { data = JSON.parse(payload); } catch { continue; }

          const delta = data.choices?.[0]?.delta;
          if (!delta) continue;

          // 文本增量
          if (delta.content) {
            fullText += delta.content;
            yield { type: 'text_delta', text: delta.content };
          }

          // tool call 增量
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap.has(idx)) {
                toolCallsMap.set(idx, { id: tc.id ?? '', name: '', arguments: '' });
              }
              const entry = toolCallsMap.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
          }

          // 检查 finish_reason
          const finish = data.choices?.[0]?.finish_reason;
          if (finish) {
            if (fullText) {
              content.push({ type: 'text', text: fullText } as Anthropic.TextBlock);
            }
            for (const [, tc] of toolCallsMap) {
              let input: Record<string, unknown>;
              try { input = JSON.parse(tc.arguments); } catch { input = { _raw: tc.arguments }; }
              content.push({
                type: 'tool_use', id: tc.id, name: tc.name, input,
              } as unknown as Anthropic.ToolUseBlock);
            }
            if (content.length === 0) {
              content.push({ type: 'text', text: '' } as Anthropic.TextBlock);
            }
            const stop_reason = finish === 'tool_calls' ? 'tool_use' : 'end_turn';
            yield { type: 'done', content, stop_reason };
            return;
          }
        }
      }

      // 流结束但没收到 finish_reason（兜底）
      if (fullText) content.push({ type: 'text', text: fullText } as Anthropic.TextBlock);
      for (const [, tc] of toolCallsMap) {
        let input: Record<string, unknown>;
        try { input = JSON.parse(tc.arguments); } catch { input = { _raw: tc.arguments }; }
        content.push({
          type: 'tool_use', id: tc.id, name: tc.name, input,
        } as unknown as Anthropic.ToolUseBlock);
      }
      if (content.length === 0) content.push({ type: 'text', text: '' } as Anthropic.TextBlock);
      const stop_reason = toolCallsMap.size > 0 ? 'tool_use' : 'end_turn';
      yield { type: 'done', content, stop_reason };
    },
  };
}
