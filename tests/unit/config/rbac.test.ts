import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupUnitDb, teardownDb, withContext, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('RBAC', () => {
  let ctx: UnitTestContext;

  beforeEach(async () => {
    ctx = await setupUnitDb();
  });

  afterEach(() => {
    teardownDb();
  });

  describe('isSystemAdmin', () => {
    it('CLI + admin role = system admin', async () => {
      const { isSystemAdmin } = await import('../../../src/auth/rbac.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () => isSystemAdmin());
      expect(result).toBe(true);
    });

    it('CLI + user role = not system admin', async () => {
      const { isSystemAdmin } = await import('../../../src/auth/rbac.js');
      const result = await withContext({ channel: 'cli', role: 'user' }, () => isSystemAdmin());
      expect(result).toBe(false);
    });

    it('feishu + admin role = not system admin', async () => {
      const { isSystemAdmin } = await import('../../../src/auth/rbac.js');
      const result = await withContext({ channel: 'feishu', role: 'admin' }, () => isSystemAdmin());
      expect(result).toBe(false);
    });

    it('telegram + admin role = not system admin', async () => {
      const { isSystemAdmin } = await import('../../../src/auth/rbac.js');
      const result = await withContext({ channel: 'telegram', role: 'admin' }, () => isSystemAdmin());
      expect(result).toBe(false);
    });

    it('wework + admin role = not system admin', async () => {
      const { isSystemAdmin } = await import('../../../src/auth/rbac.js');
      const result = await withContext({ channel: 'wework', role: 'admin' }, () => isSystemAdmin());
      expect(result).toBe(false);
    });
  });

  describe('isAgentAdmin', () => {
    it('system admin is always agent admin', async () => {
      const { isAgentAdmin } = await import('../../../src/auth/rbac.js');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        isAgentAdmin('agent-otcclaw'),
      );
      expect(result).toBe(true);
    });

    it('agent_members admin is agent admin', async () => {
      const { isAgentAdmin } = await import('../../../src/auth/rbac.js');
      const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');

      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
        'user-bob', 'bob', 'user',
      );
      ctx.db.prepare(`INSERT INTO agent_members (id, agent_id, user_id, role, created_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(
        'am-bob-otc', 'agent-otcclaw', 'user-bob', 'admin',
      );

      const result = runWithExecutionContext(
        { channel: 'feishu' as any, user: { id: 'user-bob', username: 'bob', role: 'user' } },
        () => isAgentAdmin('agent-otcclaw'),
      );
      expect(result).toBe(true);
    });

    it('agent_members user is NOT agent admin', async () => {
      const { isAgentAdmin } = await import('../../../src/auth/rbac.js');
      const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');

      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
        'user-carol', 'carol', 'user',
      );
      ctx.db.prepare(`INSERT INTO agent_members (id, agent_id, user_id, role, created_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(
        'am-carol-doc', 'agent-doctor', 'user-carol', 'user',
      );

      const result = runWithExecutionContext(
        { channel: 'feishu' as any, user: { id: 'user-carol', username: 'carol', role: 'user' } },
        () => isAgentAdmin('agent-doctor'),
      );
      expect(result).toBe(false);
    });
  });
});
