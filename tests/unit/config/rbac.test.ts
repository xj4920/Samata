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
        'am-carol-standard', 'agent-standard-test', 'user-carol', 'user',
      );

      const result = runWithExecutionContext(
        { channel: 'feishu' as any, user: { id: 'user-carol', username: 'carol', role: 'user' } },
        () => isAgentAdmin('agent-standard-test'),
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

    it('resolves canonical user id through alias chain', async () => {
      const { registerUserAliases, resolveCanonicalUserId } = await import('../../../src/auth/rbac.js');

      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
        'user-duoduo', 'duoduo', 'user',
      );
      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
        'feishu_open_ou_duoduo', 'duoduo_feishu', 'user',
      );
      registerUserAliases('user-duoduo', ['feishu_open_ou_duoduo'], 'test open id');
      registerUserAliases('feishu_open_ou_duoduo', ['wework_user_duoduo'], 'test cross channel chain');

      expect(resolveCanonicalUserId('wework_user_duoduo')).toBe('user-duoduo');
    });

    it('resolves external wework identity to manually bound Samata user', async () => {
      const { resolveExternalUser, upsertUserAlias, listUserAliases } = await import('../../../src/auth/rbac.js');

      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role, display_name) VALUES (?, ?, ?, ?)`).run(
        'user-duoduo', 'duoduo', 'user', '多多',
      );
      upsertUserAlias('duoduo', 'wework_user_abc', 'manual wework binding');

      const user = resolveExternalUser('wework', { userid: 'abc' }, 'wework_abc');
      expect(user).toMatchObject({ id: 'user-duoduo', username: 'duoduo', display_name: '多多' });

      const aliases = listUserAliases('duoduo').map(a => a.alias_user_id);
      expect(aliases).toEqual(expect.arrayContaining(['wework_user_abc', 'wework_abc']));
    });

    it('resolves feishu multi-id sender to manually bound Samata user and fills missing aliases', async () => {
      const { resolveExternalUser, upsertUserAlias, listUserAliases } = await import('../../../src/auth/rbac.js');

      ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
        'user-duoduo', 'duoduo', 'user',
      );
      upsertUserAlias('user-duoduo', 'feishu_open_ou_1', 'manual feishu binding');

      const user = resolveExternalUser('feishu', { union_id: 'on_1', user_id: 'u_1', open_id: 'ou_1' }, 'user_ou_1');
      expect(user.id).toBe('user-duoduo');

      const aliases = listUserAliases('user-duoduo').map(a => a.alias_user_id);
      expect(aliases).toEqual(expect.arrayContaining([
        'feishu_open_ou_1',
        'feishu_union_on_1',
        'feishu_user_u_1',
        'feishu_ou_1',
      ]));
    });
  });
});
