import { describe, expect, it } from 'vitest';
import { convertResponse } from '../../../src/llm/openai-compat.js';

describe('openai compat response conversion', () => {
  it('maps length finish reason to max_tokens stop reason', () => {
    const result = convertResponse({
      choices: [{
        finish_reason: 'length',
        message: { content: 'partial answer' },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }, 'test');

    expect(result.stop_reason).toBe('max_tokens');
    expect(result.content).toEqual([{ type: 'text', text: 'partial answer' }]);
  });
});
