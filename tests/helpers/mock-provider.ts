import { v4 as uuid } from 'uuid';
import type { LLMProvider, CreateMessageParams, CreateMessageResult } from '../../src/llm/provider.js';

export interface MockCall {
  params: CreateMessageParams;
  timestamp: number;
}

export class MockLLMProvider implements LLMProvider {
  name = 'mock';
  defaultModel = 'mock-model';
  calls: MockCall[] = [];
  private responseQueue: CreateMessageResult[];

  constructor(responses: CreateMessageResult[]) {
    this.responseQueue = [...responses];
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResult> {
    this.calls.push({ params, timestamp: Date.now() });
    const next = this.responseQueue.shift();
    if (!next) throw new Error('MockLLMProvider: no more responses in queue');
    return next;
  }

  /**
   * Extract real tool execution results from the conversation history.
   * Returns { toolName, toolInput, toolResult } for each tool_use → tool_result pair.
   */
  get toolExecutions(): Array<{ name: string; input: any; result: string }> {
    const executions: Array<{ name: string; input: any; result: string }> = [];
    const toolUseMap = new Map<string, { name: string; input: any }>();

    for (const call of this.calls) {
      for (const msg of call.params.messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_use') {
              toolUseMap.set(block.id, { name: block.name, input: block.input });
            }
          }
        }
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content as any[]) {
            if (block.type === 'tool_result' && toolUseMap.has(block.tool_use_id)) {
              const use = toolUseMap.get(block.tool_use_id)!;
              const alreadyRecorded = executions.some(
                e => e.name === use.name && e.result === (block.content ?? ''),
              );
              if (!alreadyRecorded) {
                executions.push({
                  name: use.name,
                  input: use.input,
                  result: block.content ?? '',
                });
              }
            }
          }
        }
      }
    }
    return executions;
  }

  /** Unique tool names that were actually executed */
  get toolsUsed(): string[] {
    return [...new Set(this.toolExecutions.map(e => e.name))];
  }

  get callCount(): number {
    return this.calls.length;
  }
}

/** Build a mock response that asks the LLM to call a single tool */
export function toolUseResponse(name: string, input: Record<string, any>, id?: string): CreateMessageResult {
  return {
    content: [
      { type: 'tool_use', id: id ?? uuid(), name, input } as any,
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

/** Build a mock response with a plain text reply (end_turn) */
export function textResponse(text: string): CreateMessageResult {
  return {
    content: [
      { type: 'text', text } as any,
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

/** Build a mock response that calls multiple tools in one turn */
export function multiToolResponse(tools: Array<{ name: string; input: Record<string, any> }>): CreateMessageResult {
  return {
    content: tools.map(t => ({
      type: 'tool_use' as const,
      id: uuid(),
      name: t.name,
      input: t.input,
    })) as any[],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}
