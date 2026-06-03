import { describe, it, expect } from 'vitest';
import { useUnitDb } from '../../helpers/unit-harness.js';

describe('wework session identity', () => {
  const unit = useUnitDb();

  it('uses canonical wework user id and registers legacy alias', async () => {
    const { getSession } = await import('../../../src/wework/session.js');

    unit.db.prepare(
      `INSERT OR IGNORE INTO agent_assignments (id, agent_id, channel, app_id) VALUES (?, ?, ?, ?)`,
    ).run('assign-wework-test', 'agent-alter-ego', 'wework', 'test-bot');
    unit.db.prepare(
      `INSERT OR IGNORE INTO users (id, username, role, display_name) VALUES (?, ?, ?, ?)`,
    ).run('wework_zhangsan', 'legacy_zhangsan', 'user', '张三');

    const sessions = new Map();
    const session = getSession('test-bot', sessions, 'zhangsan', '');

    expect(session.user.id).toBe('wework_user_zhangsan');
    expect(session.user.display_name).toBe('张三');
    const alias = unit.db.prepare(
      `SELECT canonical_user_id FROM user_aliases WHERE alias_user_id = ?`,
    ).get('wework_zhangsan') as { canonical_user_id: string } | undefined;
    expect(alias?.canonical_user_id).toBe('wework_user_zhangsan');
  });

  it('keeps group session key separate while using the same canonical user', async () => {
    const { getSession } = await import('../../../src/wework/session.js');

    unit.db.prepare(
      `INSERT OR IGNORE INTO agent_assignments (id, agent_id, channel, app_id) VALUES (?, ?, ?, ?)`,
    ).run('assign-wework-group-test', 'agent-alter-ego', 'wework', 'test-bot');

    const sessions = new Map();
    const direct = getSession('test-bot', sessions, 'zhangsan', 'wework_zhangsan');
    const group = getSession('test-bot', sessions, 'g:chat1:zhangsan', 'wework_zhangsan');

    expect(direct).not.toBe(group);
    expect(direct.user.id).toBe('wework_user_zhangsan');
    expect(group.user.id).toBe('wework_user_zhangsan');
  });
});
