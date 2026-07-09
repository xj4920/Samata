import { describe, it, expect } from 'vitest';
import { useUnitDb } from '../../helpers/unit-harness.js';

describe('wework session identity', () => {
  const unit = useUnitDb();

  it('auto-creates canonical wework user id and registers current alias only', async () => {
    const { getSession } = await import('../../../src/wework/session.js');
    const { buildWeworkAutoUserId } = await import('../../../src/auth/rbac.js');

    unit.db.prepare(
      `INSERT OR IGNORE INTO agent_assignments (id, agent_id, channel, app_id) VALUES (?, ?, ?, ?)`,
    ).run('assign-wework-test', 'agent-admin', 'wework', 'test-bot');

    const sessions = new Map();
    const created: any[] = [];
    const session = getSession('test-bot', sessions, 'zhangsan', '', {
      identityContext: {
        rawFrom: { userid: 'zhangsan' },
        rawUserId: 'zhangsan',
        msgid: 'msg-1',
        chattype: 'single',
        aibotid: 'bot-a',
        botId: 'test-bot',
        botName: 'Test Bot',
      },
      onUserAutoCreated: event => created.push(event),
    });

    expect(session.user.id).toBe(buildWeworkAutoUserId('zhangsan'));
    expect(session.user.username).toBe('wework_angsan');
    const alias = unit.db.prepare(
      `SELECT canonical_user_id FROM user_aliases WHERE alias_user_id = ?`,
    ).get('wework_user_zhangsan') as { canonical_user_id: string } | undefined;
    expect(alias?.canonical_user_id).toBe(buildWeworkAutoUserId('zhangsan'));
    const legacyAlias = unit.db.prepare(
      `SELECT canonical_user_id FROM user_aliases WHERE alias_user_id = ?`,
    ).get('wework_zhangsan') as { canonical_user_id: string } | undefined;
    expect(legacyAlias).toBeUndefined();
    expect(created).toHaveLength(1);
    expect(created[0].context.rawFrom).toEqual({ userid: 'zhangsan' });
  });

  it('keeps group session key separate while using the same canonical user', async () => {
    const { getSession } = await import('../../../src/wework/session.js');
    const { buildWeworkAutoUserId } = await import('../../../src/auth/rbac.js');

    unit.db.prepare(
      `INSERT OR IGNORE INTO agent_assignments (id, agent_id, channel, app_id) VALUES (?, ?, ?, ?)`,
    ).run('assign-wework-group-test', 'agent-admin', 'wework', 'test-bot');

    const sessions = new Map();
    const direct = getSession('test-bot', sessions, 'zhangsan', 'wework_zhangsan');
    const group = getSession('test-bot', sessions, 'g:chat1:zhangsan', 'wework_zhangsan');

    expect(direct).not.toBe(group);
    expect(direct.user.id).toBe(buildWeworkAutoUserId('zhangsan'));
    expect(group.user.id).toBe(buildWeworkAutoUserId('zhangsan'));
  });

  it('uses manual alias binding for direct and group sessions without merging session history', async () => {
    const { getSession } = await import('../../../src/wework/session.js');
    const { upsertUserAlias } = await import('../../../src/auth/rbac.js');

    unit.db.prepare(
      `INSERT OR IGNORE INTO agent_assignments (id, agent_id, channel, app_id) VALUES (?, ?, ?, ?)`,
    ).run('assign-wework-bound-user-test', 'agent-admin', 'wework', 'test-bot');
    unit.db.prepare(
      `INSERT OR IGNORE INTO users (id, username, role, display_name) VALUES (?, ?, ?, ?)`,
    ).run('user-duoduo', 'duoduo', 'user', '多多');
    upsertUserAlias('user-duoduo', 'wework_user_zhangsan', 'manual wework binding');

    const sessions = new Map();
    const direct = getSession('test-bot', sessions, 'zhangsan', 'wework_zhangsan');
    const group = getSession('test-bot', sessions, 'g:chat1:zhangsan', 'wework_zhangsan');

    expect(direct).not.toBe(group);
    expect(direct.user.id).toBe('user-duoduo');
    expect(group.user.id).toBe('user-duoduo');
    expect(direct.weworkUsername).toBe('多多');
    expect(group.weworkUsername).toBe('多多');
  });
});
