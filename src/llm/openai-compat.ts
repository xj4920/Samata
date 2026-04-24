/**
 * OpenAI 兼容格式转换工具
 * 供 MiniMax、OpenRouter 等使用 OpenAI chat/completions 格式的 provider 复用
 */
import Anthropic from '@anthropic-ai/sdk';

/* ----------------------------------------------------------------
 * OpenAI-compatible 类型
 * ---------------------------------------------------------------- */
export interface OAITool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OAIContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  /**
   * Reasoning-model output (GLM/DeepSeek thinking mode etc.).
   * When echoed back on the assistant turn, the GF gateway requires this field
   * to be present, otherwise it returns 400 "reasoning_content must be passed back".
   */
  reasoning_content?: string;
}

export interface OAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

/* ----------------------------------------------------------------
 * Anthropic → OpenAI 格式转换
 * ---------------------------------------------------------------- */

export function convertTools(tools: Anthropic.Tool[]): OAITool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

export function convertMessages(system: string, messages: Anthropic.MessageParam[]): OAIMessage[] {
  const result: OAIMessage[] = [{ role: 'system', content: system }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // 检查是否包含图片 block — 如果有则需要用 multipart content
        const parts: OAIContentPart[] = [];
        const toolResults: OAIMessage[] = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            // Anthropic image block → OpenAI image_url (data URI)
            const src = (block as any).source;
            if (src?.type === 'base64' && src.data) {
              parts.push({
                type: 'image_url',
                image_url: { url: `data:${src.media_type};base64,${src.data}` },
              });
            }
          } else if (block.type === 'tool_result') {
            const tb = block as Anthropic.ToolResultBlockParam;
            toolResults.push({
              role: 'tool',
              tool_call_id: tb.tool_use_id,
              content: typeof tb.content === 'string'
                ? tb.content
                : JSON.stringify(tb.content),
            });
          }
        }

        // 如果有图片或文本 parts，生成一条 multipart user message
        if (parts.length > 0) {
          result.push({ role: 'user', content: parts });
        }
        // tool results 仍然单独生成
        result.push(...toolResults);
      }
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: NonNullable<OAIMessage['tool_calls']> = [];
      let reasoning = '';

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
          } else if ((block as any).type === 'thinking') {
            reasoning += (block as any).thinking ?? '';
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
      if (reasoning) am.reasoning_content = reasoning;
      result.push(am);
    }
  }

  // Collect all tool_call_ids answered by subsequent tool messages so we can
  // strip any assistant.tool_calls entries that would otherwise be orphaned.
  const answeredToolCallIds = new Set<string>();
  for (const m of result) {
    if (m.role === 'tool' && m.tool_call_id) answeredToolCallIds.add(m.tool_call_id);
  }

  // Final defense: keep a 'tool' message only if the nearest non-tool ancestor
  // is an assistant carrying a matching tool_calls entry. Skipping over
  // preceding tool messages is essential for parallel tool-calls (multiple
  // tool responses for a single assistant turn), otherwise the gateway
  // rejects the request with "insufficient tool messages following tool_calls".
  const cleaned: OAIMessage[] = [];
  for (const m of result) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const keptCalls = m.tool_calls.filter(tc => answeredToolCallIds.has(tc.id));
      if (keptCalls.length === m.tool_calls.length) {
        cleaned.push(m);
      } else if (keptCalls.length > 0) {
        cleaned.push({ ...m, tool_calls: keptCalls });
      } else {
        // No tool call has a response; drop tool_calls entirely but keep any text.
        const { tool_calls: _tc, ...rest } = m;
        if (rest.content) cleaned.push(rest);
      }
      continue;
    }
    if (m.role === 'tool') {
      let anchor: OAIMessage | undefined;
      for (let i = cleaned.length - 1; i >= 0; i--) {
        if (cleaned[i].role !== 'tool') { anchor = cleaned[i]; break; }
      }
      const hasMatch = anchor?.role === 'assistant'
        && anchor.tool_calls?.some(tc => tc.id === m.tool_call_id);
      if (!hasMatch) continue;
    }
    cleaned.push(m);
  }
  return cleaned;
}

/* ----------------------------------------------------------------
 * OpenAI 响应 → Anthropic ContentBlock[] + stop_reason
 * ---------------------------------------------------------------- */

export function convertResponse(data: any, providerLabel: string): {
  content: Anthropic.ContentBlock[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
} {
  const choice = data.choices?.[0];
  if (!choice) throw new Error(`${providerLabel} 返回空 choices`);

  const usage = data.usage
    ? { input_tokens: data.usage.prompt_tokens ?? 0, output_tokens: data.usage.completion_tokens ?? 0 }
    : undefined;

  const content: Anthropic.ContentBlock[] = [];

  if (choice.message?.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: choice.message.reasoning_content,
      signature: '',
    } as unknown as Anthropic.ContentBlock);
  }

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

  if (content.length === 0) {
    content.push({ type: 'text', text: '' } as Anthropic.TextBlock);
  }

  const stop_reason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
  return { content, stop_reason, usage };
}

/* ----------------------------------------------------------------
 * 流式解析: 从 SSE 流中聚合内容并产出 StreamEvent
 * ---------------------------------------------------------------- */

import type { StreamEvent } from './provider.js';

export async function* parseSSEStream(
  body: AsyncIterable<Uint8Array>,
  providerLabel: string,
): AsyncGenerator<StreamEvent> {
  const content: Anthropic.ContentBlock[] = [];
  let fullText = '';
  let fullReasoning = '';
  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
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

      if (delta.reasoning_content) {
        fullReasoning += delta.reasoning_content;
      }

      if (delta.content) {
        fullText += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }

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

      const finish = data.choices?.[0]?.finish_reason;
      if (finish) {
        if (fullReasoning) {
          content.push({
            type: 'thinking',
            thinking: fullReasoning,
            signature: '',
          } as unknown as Anthropic.ContentBlock);
        }
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
        const usage = data.usage
          ? { input_tokens: data.usage.prompt_tokens ?? 0, output_tokens: data.usage.completion_tokens ?? 0 }
          : undefined;
        yield { type: 'done', content, stop_reason, usage };
        return;
      }
    }
  }

  // 流结束但没收到 finish_reason（兜底）
  if (fullReasoning) {
    content.push({
      type: 'thinking',
      thinking: fullReasoning,
      signature: '',
    } as unknown as Anthropic.ContentBlock);
  }
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
  yield { type: 'done', content, stop_reason, usage: undefined };
}
