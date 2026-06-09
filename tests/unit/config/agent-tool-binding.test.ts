import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupUnitDb, teardownDb, withContext, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('applyAgentToolBinding', () => {
  let ctx: UnitTestContext;

  beforeEach(async () => {
    ctx = await setupUnitDb();
  });

  afterEach(() => {
    teardownDb();
  });

  async function bind(input: any, context = { channel: 'cli', role: 'admin', agentName: 'otcclaw' }) {
    const { applyAgentToolBinding } = await import('../../../src/llm/agents/tool-binding.js');
    return withContext(context, () => applyAgentToolBinding({ agentName: 'otcclaw', ...input }));
  }

  it('adds tools to tools_list once', async () => {
    const first = await bind({ addTools: ['query_clients', 'query_trades'] });
    expect(first.success).toBe(true);
    expect(first.success && first.changed).toBe(true);

    const row = ctx.db.prepare("SELECT tools_list FROM agents WHERE name = 'otcclaw'").get() as { tools_list: string };
    const tools = JSON.parse(row.tools_list) as string[];
    expect(tools.filter(tool => tool === 'query_clients')).toHaveLength(1);
    expect(tools).toContain('query_trades');

    const second = await bind({ addTools: ['query_clients', 'query_trades'] });
    expect(second.success).toBe(true);
    expect(second.success && second.changed).toBe(false);

    const after = ctx.db.prepare("SELECT tools_list FROM agents WHERE name = 'otcclaw'").get() as { tools_list: string };
    const afterTools = JSON.parse(after.tools_list) as string[];
    expect(afterTools.filter(tool => tool === 'query_clients')).toHaveLength(1);
  });

  it('sets member blocklist mode and appends member-only blocks', async () => {
    ctx.db.prepare("UPDATE agents SET user_tools_mode = 'inherit', user_tools_list = NULL WHERE name = 'otcclaw'").run();

    const result = await bind({ memberBlockTools: ['sync_normal_trading_summary'] });
    expect(result.success).toBe(true);
    expect(result.success && result.changed).toBe(true);

    const row = ctx.db.prepare("SELECT user_tools_mode, user_tools_list FROM agents WHERE name = 'otcclaw'").get() as {
      user_tools_mode: string;
      user_tools_list: string;
    };
    expect(row.user_tools_mode).toBe('blocklist');
    expect(JSON.parse(row.user_tools_list)).toEqual(['sync_normal_trading_summary']);
  });

  it('removes member blocklist entries idempotently', async () => {
    await bind({ memberBlockTools: ['sync_normal_trading_summary', 'sync_fast_trading_summary'] });

    const first = await bind({ memberUnblockTools: ['sync_fast_trading_summary'] });
    expect(first.success).toBe(true);
    expect(first.success && first.changed).toBe(true);

    const second = await bind({ memberUnblockTools: ['sync_fast_trading_summary'] });
    expect(second.success).toBe(true);
    expect(second.success && second.changed).toBe(false);

    const row = ctx.db.prepare("SELECT user_tools_list FROM agents WHERE name = 'otcclaw'").get() as { user_tools_list: string };
    const userTools = JSON.parse(row.user_tools_list) as string[];
    expect(userTools).toContain('sync_normal_trading_summary');
    expect(userTools).not.toContain('sync_fast_trading_summary');
  });

  it('fails outside CLI channel', async () => {
    const result = await bind(
      { addTools: ['query_clients'] },
      { channel: 'wework', role: 'admin', agentName: 'otcclaw' },
    );

    expect(result).toEqual({ success: false, error: '权限不足：Agent 工具绑定仅支持 CLI channel' });
  });
});
