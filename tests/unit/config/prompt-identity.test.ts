import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupUnitDb, teardownDb, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('prompt identity context', () => {
  let ctx: UnitTestContext;

  beforeEach(async () => {
    ctx = await setupUnitDb();
  });

  afterEach(() => {
    teardownDb();
  });

  it('includes current asker identity guidance', async () => {
    const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');
    const { getAgent } = await import('../../../src/llm/agents/config.js');
    const { buildSystemPrompt } = await import('../../../src/llm/agents/prompt.js');

    ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role, display_name) VALUES (?, ?, ?, ?)`).run(
      'user-duoduo', 'duoduo', 'user', '多多',
    );

    const agent = getAgent('standard-test');
    const user = { id: 'user-duoduo', username: 'duoduo', role: 'user' as const, display_name: '多多' };
    const prompt = runWithExecutionContext(
      { channel: 'feishu', user, agent },
      () => buildSystemPrompt(agent, user),
    );

    expect(prompt).toContain('当前提问人：多多');
    expect(prompt).toContain('Samata 用户 ID：user-duoduo');
    expect(prompt).toContain('用户说“我”“本人”“我的”时，默认指当前提问人');
  });
});
