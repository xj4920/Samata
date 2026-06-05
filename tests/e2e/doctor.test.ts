import { describe, it, expect } from 'vitest';
import { useTestAgent } from '../helpers/test-harness.js';

describe('doctor agent', () => {
  const { init } = useTestAgent();

  it('responds to basic consultation without requiring private plugin tools', async () => {
    const { runChat } = await init('doctor');
    const { reply } = await runChat('请给我一些改善睡眠作息的建议。');

    expect(reply).toBeTruthy();
  });

  it('can explain how to use imported documents for prior records', async () => {
    const { runChat } = await init('doctor');
    const { reply } = await runChat('如果我上传检查报告，你可以怎么帮我整理？');

    expect(reply).toBeTruthy();
  });
});
