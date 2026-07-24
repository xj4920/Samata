import { describe, expect, it } from 'vitest';
import { buildToolResultMessage } from '../../../src/llm/agent.js';

describe('agent tool result message ordering', () => {
  it('keeps every tool_result before loop warning text in the immediate user message', () => {
    const message = buildToolResultMessage([
      { type: 'tool_result', tool_use_id: 'call-1', content: '{"success":true}' },
      { type: 'tool_result', tool_use_id: 'call-2', content: '{"success":true}' },
    ], ['检测到重复调用，请停止。']);

    expect(message.role).toBe('user');
    expect(message.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call-1', content: '{"success":true}' },
      { type: 'tool_result', tool_use_id: 'call-2', content: '{"success":true}' },
      { type: 'text', text: '检测到重复调用，请停止。' },
    ]);
  });
});
