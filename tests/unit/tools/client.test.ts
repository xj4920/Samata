import { describe, it, expect, vi } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

// Mock trade module (InfluxDB dependency)
vi.mock('../../../src/commands/trade.js', () => ({
  fetchLatestNotionals: async () => new Map(),
  fetchLatestTradeData: async () => ({ data: [] }),
  formatNum: (n: number) => String(n),
}));

describe('client tools', () => {
  const env = useUnitDb({ seed: true });

  // --- 1. Model layer (pure logic, no DB) ---

  describe('model (pure logic)', () => {
    it('nextState traverses all states forward', async () => {
      const { nextState } = await import('../../../src/models/client.js');
      expect(nextState('initial_contact')).toBe('requirement_discussion');
      expect(nextState('requirement_discussion')).toBe('solution_design');
      expect(nextState('solution_design')).toBe('uat');
      expect(nextState('uat')).toBe('prod');
    });

    it('nextState returns null at final state', async () => {
      const { nextState } = await import('../../../src/models/client.js');
      expect(nextState('prod')).toBeNull();
    });

    it('prevState traverses all states backward', async () => {
      const { prevState } = await import('../../../src/models/client.js');
      expect(prevState('prod')).toBe('uat');
      expect(prevState('uat')).toBe('solution_design');
      expect(prevState('solution_design')).toBe('requirement_discussion');
      expect(prevState('requirement_discussion')).toBe('initial_contact');
    });

    it('prevState returns null at initial state', async () => {
      const { prevState } = await import('../../../src/models/client.js');
      expect(prevState('initial_contact')).toBeNull();
    });

    it('classifyClient: isFt=true with shortFinancing → 中性客户', async () => {
      const { classifyClient } = await import('../../../src/models/client.js');
      expect(classifyClient(true, 0.05)).toBe('中性客户');
      expect(classifyClient(true, 0)).toBe('中性客户');
    });

    it('classifyClient: isFt=true without shortFinancing → 多空客户', async () => {
      const { classifyClient } = await import('../../../src/models/client.js');
      expect(classifyClient(true, null)).toBe('多空客户');
    });

    it('classifyClient: isFt=false → null regardless of shortFinancing', async () => {
      const { classifyClient } = await import('../../../src/models/client.js');
      expect(classifyClient(false, 0.05)).toBeNull();
      expect(classifyClient(false, null)).toBeNull();
      expect(classifyClient(false, 0)).toBeNull();
    });
  });

  // --- 2. Commands layer: CRUD ---

  describe('commands (CRUD)', () => {
    it('fetchClients returns all seeded clients without filter', async () => {
      const { fetchClients } = await import('../../../src/commands/client.js');
      const clients = fetchClients();
      expect(clients.length).toBe(3);
      const names = clients.map(c => c.name);
      expect(names).toContain('宽德');
      expect(names).toContain('Jump');
      expect(names).toContain('Jinde');
    });

    it('fetchClients filters by state', async () => {
      const { fetchClients } = await import('../../../src/commands/client.js');
      const prodClients = fetchClients({ state: 'prod' });
      expect(prodClients.length).toBe(2);
      expect(prodClients.every(c => c.state === 'prod')).toBe(true);
    });

    it('fetchClients filters by keyword', async () => {
      const { fetchClients } = await import('../../../src/commands/client.js');
      const result = fetchClients({ keyword: '极速' });
      expect(result.length).toBeGreaterThan(0);
      result.forEach(c => {
        const match = c.name.includes('极速') || c.tags?.includes('极速') || c.wework_group?.includes('极速');
        expect(match).toBe(true);
      });
    });

    it('fetchClient finds by exact name', async () => {
      const { fetchClient } = await import('../../../src/commands/client.js');
      const client = fetchClient('宽德');
      expect(client).not.toBeNull();
      expect(client!.name).toBe('宽德');
    });

    it('fetchClient finds by id prefix', async () => {
      const { fetchClient } = await import('../../../src/commands/client.js');
      const client = fetchClient('client-kuande');
      expect(client).not.toBeNull();
      expect(client!.name).toBe('宽德');
    });

    it('fetchClient returns null for non-existent client', async () => {
      const { fetchClient } = await import('../../../src/commands/client.js');
      const client = fetchClient('不存在的客户xyz');
      expect(client).toBeNull();
    });

    it('createClient creates a new client', async () => {
      const { createClient, fetchClient } = await import('../../../src/commands/client.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        createClient({ name: 'TestNew', contact: '联系人A', notes: '测试' }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.name).toBe('TestNew');
        const found = fetchClient('TestNew');
        expect(found).not.toBeNull();
        expect(found!.contact).toBe('联系人A');
      }
    });

    it('createClient allows duplicate name (no UNIQUE constraint)', async () => {
      const { createClient, fetchClients } = await import('../../../src/commands/client.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        createClient({ name: '宽德' }),
      );
      expect(result.success).toBe(true);
      const all = fetchClients({ keyword: '宽德' });
      expect(all.length).toBe(2);
    });

    it('updateClient updates allowed fields', async () => {
      const { updateClient, fetchClient } = await import('../../../src/commands/client.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        updateClient('宽德', { contact: '新联系人', notes: '更新备注' }),
      );
      expect(result.success).toBe(true);
      const updated = fetchClient('宽德');
      expect(updated!.contact).toBe('新联系人');
      expect(updated!.notes).toBe('更新备注');
    });

    it('updateClient rejects state field', async () => {
      const { updateClient } = await import('../../../src/commands/client.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        updateClient('宽德', { state: 'uat' }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('state');
      }
    });

    it('updateClient fails for non-existent client', async () => {
      const { updateClient } = await import('../../../src/commands/client.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        updateClient('不存在xyz', { contact: 'xx' }),
      );
      expect(result.success).toBe(false);
    });

    it('deleteClient with dryRun=true returns preview without deleting', async () => {
      const { deleteClient, fetchClient } = await import('../../../src/commands/client.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        deleteClient('Jinde', true),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.dry_run).toBe(true);
        expect(result.name).toBe('Jinde');
      }
      const stillExists = fetchClient('Jinde');
      expect(stillExists).not.toBeNull();
    });

    it('deleteClient with dryRun=false actually deletes', async () => {
      const { deleteClient, fetchClient } = await import('../../../src/commands/client.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        deleteClient('Jinde', false),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.dry_run).toBe(false);
        expect(result.deleted).toBe(true);
      }
      const gone = fetchClient('Jinde');
      expect(gone).toBeNull();
    });
  });

  // --- 3. Commands layer: state machine ---

  describe('commands (state machine)', () => {
    it('advanceClient moves Jump from uat to prod', async () => {
      const { advanceClient, fetchClient } = await import('../../../src/commands/client.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        advanceClient('Jump'),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.from).toBe('UAT');
        expect(result.to).toBe('PROD');
      }
      const after = fetchClient('Jump');
      expect(after!.state).toBe('prod');
    });

    it('advanceClient fails when already at prod', async () => {
      const { advanceClient } = await import('../../../src/commands/client.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        advanceClient('宽德'),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('最终状态');
      }
    });

    it('rollbackClient moves Jump from uat to solution_design', async () => {
      const { rollbackClient, fetchClient } = await import('../../../src/commands/client.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        rollbackClient('Jump'),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.from).toBe('UAT');
        expect(result.to).toBe('Solution Design');
      }
      const after = fetchClient('Jump');
      expect(after!.state).toBe('solution_design');
    });

    it('rollbackClient fails when already at initial_contact', async () => {
      const { rollbackClient, createClient } = await import('../../../src/commands/client.js');
      await withContext({ channel: 'cli', role: 'admin' }, () =>
        createClient({ name: 'Newbie' }),
      );
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        rollbackClient('Newbie'),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('初始状态');
      }
    });

    it('fetchHistory returns events after operations', async () => {
      const { createClient, advanceClient, fetchHistory } = await import('../../../src/commands/client.js');
      await withContext({ channel: 'cli', role: 'admin' }, () =>
        createClient({ name: 'HistoryTest' }),
      );
      await withContext({ channel: 'cli', role: 'admin' }, () =>
        advanceClient('HistoryTest'),
      );

      const history = fetchHistory('HistoryTest');
      expect(history).not.toBeNull();
      expect(history!.name).toBe('HistoryTest');
      const actions = history!.events.map(e => e.action);
      expect(actions).toContain('create');
      expect(actions).toContain('advance');
    });
  });

  // --- 4. Tool handler layer ---

  describe('tool handler', () => {
    it('query_clients returns JSON with clients array', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        clientTools.handleTool('query_clients', {}),
      );
      expect(result).toBeTruthy();
      const parsed = JSON.parse(result!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
      expect(parsed[0]).toHaveProperty('name');
      expect(parsed[0]).toHaveProperty('state');
    });

    it('query_clients with keyword filter', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        clientTools.handleTool('query_clients', { keyword: 'FIX' }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.some((c: any) => c.name === 'Jump')).toBe(true);
    });

    it('view_client returns client detail JSON', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        clientTools.handleTool('view_client', { name_or_id: '宽德' }),
      );
      expect(result).toBeTruthy();
      const parsed = JSON.parse(result!);
      expect(parsed.name).toBe('宽德');
      expect(parsed.state).toBe('PROD');
    });

    it('view_client returns error for non-existent', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        clientTools.handleTool('view_client', { name_or_id: 'NONEXIST999' }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.error).toBeDefined();
    });

    it('get_client_history returns events array', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        clientTools.handleTool('get_client_history', { name_or_id: '宽德' }),
      );
      expect(result).toBeTruthy();
      const parsed = JSON.parse(result!);
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('add_client via handleTool (admin)', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        clientTools.handleTool('add_client', { name: 'ToolAdded' }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.success).toBe(true);
      expect(parsed.name).toBe('ToolAdded');
    });

    it('delete_client via handleTool defaults to dry_run', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        clientTools.handleTool('delete_client', { name_or_id: '宽德' }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.success).toBe(true);
      expect(parsed.dry_run).toBe(true);

      // Verify not actually deleted
      const { fetchClient } = await import('../../../src/commands/client.js');
      const still = fetchClient('宽德');
      expect(still).not.toBeNull();
    });

    it('handleTool returns null for unknown tool', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        clientTools.handleTool('nonexistent_tool', {}),
      );
      expect(result).toBeNull();
    });
  });

  // --- 5. RBAC ---

  describe('RBAC', () => {
    it('add_client denied for non-admin (agent member)', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');

      // Non-admin member context: user is not agent admin
      const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');
      const { setCurrentUser } = await import('../../../src/auth/rbac.js');
      const { getAgent } = await import('../../../src/llm/agents/config.js');

      env.db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)").run(
        'user-member', 'member_user', 'user',
      );
      const agent = getAgent('otcclaw');
      env.db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)").run(
        'am-member-otc', agent.id, 'user-member', 'user',
      );

      setCurrentUser({ id: 'user-member', username: 'member_user', role: 'user' } as any);
      const result = await runWithExecutionContext(
        { channel: 'wework' as any, user: { id: 'user-member', username: 'member_user', role: 'user' }, agent },
        () => clientTools.handleTool('add_client', { name: 'ShouldFail' }),
      );

      const parsed = JSON.parse(result!);
      expect(parsed.error).toContain('权限不足');
    });

    it('update_client denied for non-admin', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');
      const { setCurrentUser } = await import('../../../src/auth/rbac.js');
      const { getAgent } = await import('../../../src/llm/agents/config.js');

      env.db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)").run(
        'user-member2', 'member2', 'user',
      );
      const agent = getAgent('otcclaw');
      env.db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)").run(
        'am-member2-otc', agent.id, 'user-member2', 'user',
      );

      setCurrentUser({ id: 'user-member2', username: 'member2', role: 'user' } as any);
      const result = await runWithExecutionContext(
        { channel: 'wework' as any, user: { id: 'user-member2', username: 'member2', role: 'user' }, agent },
        () => clientTools.handleTool('update_client', { name_or_id: '宽德', fields: { contact: 'hack' } }),
      );

      const parsed = JSON.parse(result!);
      expect(parsed.error).toContain('权限不足');
    });

    it('delete_client denied for non-admin', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');
      const { setCurrentUser } = await import('../../../src/auth/rbac.js');
      const { getAgent } = await import('../../../src/llm/agents/config.js');

      env.db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)").run(
        'user-member3', 'member3', 'user',
      );
      const agent = getAgent('otcclaw');
      env.db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)").run(
        'am-member3-otc', agent.id, 'user-member3', 'user',
      );

      setCurrentUser({ id: 'user-member3', username: 'member3', role: 'user' } as any);
      const result = await runWithExecutionContext(
        { channel: 'wework' as any, user: { id: 'user-member3', username: 'member3', role: 'user' }, agent },
        () => clientTools.handleTool('delete_client', { name_or_id: '宽德', dry_run: false }),
      );

      const parsed = JSON.parse(result!);
      expect(parsed.error).toContain('权限不足');
    });

    it('advance_client denied for non-admin', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');
      const { setCurrentUser } = await import('../../../src/auth/rbac.js');
      const { getAgent } = await import('../../../src/llm/agents/config.js');

      env.db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)").run(
        'user-member4', 'member4', 'user',
      );
      const agent = getAgent('otcclaw');
      env.db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)").run(
        'am-member4-otc', agent.id, 'user-member4', 'user',
      );

      setCurrentUser({ id: 'user-member4', username: 'member4', role: 'user' } as any);
      const result = await runWithExecutionContext(
        { channel: 'wework' as any, user: { id: 'user-member4', username: 'member4', role: 'user' }, agent },
        () => clientTools.handleTool('advance_client', { name_or_id: 'Jump' }),
      );

      const parsed = JSON.parse(result!);
      expect(parsed.error).toContain('权限不足');
    });

    it('query_clients allowed for non-admin (read-only)', async () => {
      const clientTools = await import('../../../src/tools/client-tools.js');
      const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');
      const { setCurrentUser } = await import('../../../src/auth/rbac.js');
      const { getAgent } = await import('../../../src/llm/agents/config.js');

      env.db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)").run(
        'user-reader', 'reader', 'user',
      );
      const agent = getAgent('otcclaw');
      env.db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)").run(
        'am-reader-otc', agent.id, 'user-reader', 'user',
      );

      setCurrentUser({ id: 'user-reader', username: 'reader', role: 'user' } as any);
      const result = await runWithExecutionContext(
        { channel: 'wework' as any, user: { id: 'user-reader', username: 'reader', role: 'user' }, agent },
        () => clientTools.handleTool('query_clients', {}),
      );

      const parsed = JSON.parse(result!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });
  });

  // --- 6. Pricing helpers ---

  describe('pricing helpers', () => {
    it('parsePricingRange: valid JSON', async () => {
      const { parsePricingRange } = await import('../../../src/commands/client.js');
      const json = JSON.stringify({
        long_financing_spread: { min: 0.01, max: 0.03, products: ['A', 'B'] },
        commission: { min: 0.0001, max: 0.0002, products: ['A'] },
      });
      const result = parsePricingRange(json);
      expect(result).not.toBeNull();
      expect(result!.long_financing_spread!.min).toBe(0.01);
      expect(result!.commission!.products).toContain('A');
    });

    it('parsePricingRange: null/undefined/empty → null', async () => {
      const { parsePricingRange } = await import('../../../src/commands/client.js');
      expect(parsePricingRange(null)).toBeNull();
      expect(parsePricingRange(undefined)).toBeNull();
      expect(parsePricingRange('')).toBeNull();
    });

    it('parsePricingRange: invalid JSON → null', async () => {
      const { parsePricingRange } = await import('../../../src/commands/client.js');
      expect(parsePricingRange('not json')).toBeNull();
    });

    it('formatFieldWithRange: value with range', async () => {
      const { formatFieldWithRange } = await import('../../../src/commands/client.js');
      const result = formatFieldWithRange(0.01, { min: 0.005, max: 0.02, products: ['A'] });
      expect(result).toContain('0.01');
      expect(result).toContain('range');
    });

    it('formatFieldWithRange: value without range', async () => {
      const { formatFieldWithRange } = await import('../../../src/commands/client.js');
      expect(formatFieldWithRange(0.01)).toBe('0.01');
      expect(formatFieldWithRange(0.01, null)).toBe('0.01');
    });

    it('formatFieldWithRange: null value → dash', async () => {
      const { formatFieldWithRange } = await import('../../../src/commands/client.js');
      expect(formatFieldWithRange(null)).toBe('-');
    });
  });
});
