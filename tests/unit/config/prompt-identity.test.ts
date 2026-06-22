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

  it('includes TIClaw LogYi time range guard guidance', async () => {
    const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');
    const { getAgent } = await import('../../../src/llm/agents/config.js');
    const { buildSystemPrompt } = await import('../../../src/llm/agents/prompt.js');

    ctx.db.prepare(`
      INSERT OR IGNORE INTO agents (
        id, name, display_name, description, tools_mode, tools_list, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'agent-ticlaw',
      'ticlaw',
      'TIClaw',
      'Test TIClaw fixture',
      'standard',
      JSON.stringify(['search_knowledge']),
      'admin-001',
    );

    const agent = getAgent('ticlaw');
    const user = { id: 'test-user', username: 'testadmin', role: 'admin' as const };
    const prompt = runWithExecutionContext(
      { channel: 'cli', user, agent },
      () => buildSystemPrompt(agent, user),
    );

    expect(prompt).toContain('用户没有明确时间时，默认只查当前自然日');
    expect(prompt).toContain('不得为了“多找点证据”自行扩大到跨日、跨年或历史年份');
    expect(prompt).toContain('命中范围外的历史日志只能标为历史背景或干扰项');
  });
});
