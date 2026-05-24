import { describe, it, expect } from 'vitest';
import { useTestAgent } from '../helpers/test-harness.js';

describe('tutor agent', () => {
  const { init } = useTestAgent();

  it('介绍下自己 → 应返回文本回复', async () => {
    const { runChat } = await init('tutor');
    const { reply } = await runChat('介绍下自己');

    expect(reply).toBeTruthy();
    expect(reply.length).toBeGreaterThan(50);
  });

  it('建议小学生如何平衡学习与运动 → 应返回文本回复', async () => {
    const { runChat } = await init('tutor');
    const { reply } = await runChat('建议小学生如何平衡学习与运动？');

    expect(reply).toBeTruthy();
    expect(reply.length).toBeGreaterThan(50);
  });
});
