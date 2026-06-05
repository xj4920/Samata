import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupUnitDb, teardownDb, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('/user command', () => {
  let ctx: UnitTestContext;

  beforeEach(async () => {
    ctx = await setupUnitDb();
  });

  afterEach(() => {
    teardownDb();
  });

  async function runUserCommand(
    args: string,
    channel: 'cli' | 'feishu' = 'cli',
    role: 'admin' | 'user' = 'admin',
  ): Promise<void> {
    const { runWithExecutionContext } = await import('../../../src/runtime/execution-context.js');
    const { handleUser } = await import('../../../src/commands/user.js');
    await runWithExecutionContext(
      { channel, user: { id: 'test-user', username: 'testadmin', role } },
      () => handleUser(args),
    );
  }

  it('adds and deletes user aliases as CLI system admin', async () => {
    ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role, display_name) VALUES (?, ?, ?, ?)`).run(
      'user-duoduo', 'duoduo', 'user', '多多',
    );

    await runUserCommand('alias add duoduo wework_user_abc manual binding');

    const row = ctx.db.prepare(
      'SELECT canonical_user_id, note FROM user_aliases WHERE alias_user_id = ?',
    ).get('wework_user_abc') as { canonical_user_id: string; note: string } | undefined;
    expect(row).toEqual({ canonical_user_id: 'user-duoduo', note: 'manual binding' });

    await runUserCommand('alias del wework_user_abc');
    const deleted = ctx.db.prepare(
      'SELECT 1 FROM user_aliases WHERE alias_user_id = ?',
    ).get('wework_user_abc');
    expect(deleted).toBeUndefined();
  });

  it('rejects alias changes from bot channels even when role is admin', async () => {
    ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
      'user-duoduo', 'duoduo', 'user',
    );

    await runUserCommand('alias add duoduo feishu_open_ou_1 bot should fail', 'feishu', 'admin');

    const row = ctx.db.prepare(
      'SELECT 1 FROM user_aliases WHERE alias_user_id = ?',
    ).get('feishu_open_ou_1');
    expect(row).toBeUndefined();
  });

  it('updates user display name and role by username', async () => {
    ctx.db.prepare(`INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)`).run(
      'user-duoduo', 'duoduo', 'user',
    );

    await runUserCommand('update duoduo --display-name 多多 --role admin');

    const row = ctx.db.prepare(
      'SELECT display_name, role FROM users WHERE id = ?',
    ).get('user-duoduo') as { display_name: string; role: string } | undefined;
    expect(row).toEqual({ display_name: '多多', role: 'admin' });
  });
});
