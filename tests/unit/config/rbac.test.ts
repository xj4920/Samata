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

    it('agent_members legacy alias admin is agent admin for canonical user', async () => {
      const { isAgentAdmin, registerUserAliases } = await import('../../../src/auth/rbac.js');
      const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');

      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
        'wework_user_bob', 'bob2', 'user',
      );
      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
        'wework_bob', 'bob_legacy', 'user',
      );
      registerUserAliases('wework_user_bob', ['wework_bob'], 'test legacy wework alias');
      ctx.db.prepare(`INSERT INTO agent_members (id, agent_id, user_id, role, created_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(
        'am-bob-legacy-otc', 'agent-otcclaw', 'wework_bob', 'admin',
      );

      const result = runWithExecutionContext(
        { channel: 'wework' as any, user: { id: 'wework_user_bob', username: 'bob2', role: 'user' } },
        () => isAgentAdmin('agent-otcclaw'),
      );
      expect(result).toBe(true);
    });
  });

  describe('identity aliases', () => {
    it('builds canonical IDs by platform priority', async () => {
      const { buildCanonicalUserId } = await import('../../../src/auth/rbac.js');

      expect(buildCanonicalUserId('feishu', { union_id: 'on_1', user_id: 'u_1', open_id: 'ou_1' }))
        .toBe('feishu_union_on_1');
      expect(buildCanonicalUserId('feishu', { user_id: 'u_1', open_id: 'ou_1' }))
        .toBe('feishu_user_u_1');
      expect(buildCanonicalUserId('feishu', { open_id: 'ou_1' }))
        .toBe('feishu_open_ou_1');
      expect(buildCanonicalUserId('wework', { userid: 'zhangsan' }))
        .toBe('wework_user_zhangsan');
    });

    it('resolves transitive aliases across platform IDs', async () => {
      const { registerUserAliases, resolveUserScopeIds } = await import('../../../src/auth/rbac.js');

      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
        'feishu_union_on_x', 'xjun', 'user',
      );
      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
        'feishu_ou_old', 'xjun_old', 'user',
      );
      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
        'wework_user_identity_test', 'xjun_wework', 'user',
      );
      registerUserAliases('feishu_union_on_x', ['feishu_ou_old'], 'test feishu upgrade');
      registerUserAliases('feishu_ou_old', ['wework_user_identity_test'], 'test cross platform');
      registerUserAliases('wework_user_identity_test', ['wework_identity_test'], 'test wework legacy');

      const ids = resolveUserScopeIds('wework_identity_test');
      expect(ids).toEqual(expect.arrayContaining([
        'feishu_union_on_x',
        'feishu_ou_old',
        'wework_user_identity_test',
        'wework_identity_test',
      ]));
    });
  });
});
