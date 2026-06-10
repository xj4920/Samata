import { describe, expect, it } from 'vitest';
import {
  buildImageRecognitionFallbackInput,
  collectLocalImagePathsFromContext,
  type ImageInput,
} from '../../../src/llm/agent.js';

describe('image context fallback', () => {
  it('collects image paths from text and image metadata', () => {
    const images: ImageInput[] = [
      { data: 'abc', mediaType: 'image/jpeg', path: '/tmp/samata/uploads/standard-test/a_image.jpg' },
      { data: 'def', mediaType: 'image/png', path: '/tmp/samata/uploads/standard-test/a_image.jpg' },
      { data: 'ghi', mediaType: 'image/png', path: '/tmp/samata/uploads/standard-test/b_image.png' },
    ];

    expect(collectLocalImagePathsFromContext('用户发送了图片，已保存至 /tmp/samata/uploads/standard-test/c_image.webp', images)).toEqual([
      '/tmp/samata/uploads/standard-test/a_image.jpg',
      '/tmp/samata/uploads/standard-test/b_image.png',
      '/tmp/samata/uploads/standard-test/c_image.webp',
    ]);
  });

  it('builds a Codex recognition fallback prompt instead of losing the image path', () => {
    const prompt = buildImageRecognitionFallbackInput(
      '用户发送了图片，已保存至 /tmp/samata/uploads/standard-test/sleep.jpg',
      [{ data: 'abc', mediaType: 'image/jpeg', path: '/tmp/samata/uploads/standard-test/sleep.jpg' }],
      'MiniMax VLM error (2056): usage limit exceeded',
    );

    expect(prompt).toContain('/tmp/samata/uploads/standard-test/sleep.jpg');
    expect(prompt).toContain('recognize_image_codex');
    expect(prompt).toContain('不要向用户再次索要图片路径');
  });
});
