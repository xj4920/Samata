import { describe, expect, it } from 'vitest';
import { extractBigModelOcrText } from '../../../src/llm/bigmodel-ocr.js';

describe('bigmodel ocr response parsing', () => {
  it('extracts markdown results from layout parsing responses', () => {
    expect(extractBigModelOcrText({ md_results: ['# 标题', '| A | B |'] })).toBe('# 标题\n\n| A | B |');
    expect(extractBigModelOcrText({ data: { md_results: '正文内容' } })).toBe('正文内容');
  });

  it('falls back to chat-style content when present', () => {
    const text = extractBigModelOcrText({
      choices: [
        { message: { content: '识别结果' } },
      ],
    });

    expect(text).toBe('识别结果');
  });
});
