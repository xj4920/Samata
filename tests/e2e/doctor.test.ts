import { describe, it, expect } from 'vitest';
import { useTestAgent } from '../helpers/test-harness.js';

describe('doctor agent', () => {
  const { init } = useTestAgent();

  it('最近我的睡眠质量如何 → 应调用 query_health_records', async () => {
    const { runChat } = await init('doctor');
    const { reply, tools } = await runChat('最近我的睡眠质量如何？');

    expect(reply).toBeTruthy();
    const healthTool = tools.find(
      t => t.name === 'query_health_records' || t.name === 'health_summary',
    );
    expect(healthTool).toBeDefined();
    expect(healthTool!.result.length).toBeGreaterThan(0);
  });

  it('目前有哪些病例 → 应调用健康相关工具', async () => {
    const { runChat } = await init('doctor');
    const { reply, tools } = await runChat('目前有哪些病例？');

    expect(reply).toBeTruthy();
    const healthTool = tools.find(
      t => t.name === 'query_health_records' || t.name === 'health_summary' || t.name === 'list_documents',
    );
    expect(healthTool).toBeDefined();
  });
});
