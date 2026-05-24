import { describe, it, expect } from 'vitest';
import { useTestAgent } from '../helpers/test-harness.js';

describe('alter-ego agent', () => {
  const { init } = useTestAgent();

  it('最近我有哪些todo事项 → 应调用 list_todos', async () => {
    const { runChat } = await init('alter-ego');
    const { reply, tools } = await runChat('最近我有哪些todo事项？');

    expect(reply).toBeTruthy();
    const todoTool = tools.find(t => t.name === 'list_todos');
    expect(todoTool).toBeDefined();

    const result = JSON.parse(todoTool!.result);
    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(3);
    expect(result.some((t: any) => t.title === '完成季度报告')).toBe(true);
  });

  it('调用wind数据库查看国投电力最近收盘价 → 应调用 sandbox_exec', async () => {
    const { runChat } = await init('alter-ego');
    const { reply, tools } = await runChat('调用wind数据库查看国投电力最近收盘价');

    expect(reply).toBeTruthy();
    const sandbox = tools.find(t => t.name === 'sandbox_exec');
    expect(sandbox).toBeDefined();
    expect(sandbox!.result.length).toBeGreaterThan(0);
  });
});
