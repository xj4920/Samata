import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupUnitDb, teardownDb, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('schema integrity', () => {
  let ctx: UnitTestContext;

  beforeEach(async () => {
    ctx = await setupUnitDb({ seedTestAgents: false });
  });

  afterEach(() => {
    teardownDb();
  });

  describe('core tables exist', () => {
    const expectedTables = [
      'knowledge', 'knowledge_agents', 'skills', 'users',
      'user_aliases', 'agents', 'agent_members', 'todos',
      'reminders', 'bot_apps', 'agent_assignments',
      'documents', 'pricing_quotes', 'memory',
      'wrong_questions', 'wrong_question_assets',
      'scheduled_tasks', 'migrations', 'telemetry_turn',
    ];

    for (const table of expectedTables) {
      it(`table "${table}" exists`, () => {
        const row = ctx.db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        ).get(table);
        expect(row).toBeDefined();
      });
    }
  });

  describe('agent seed data', () => {
    it('core platform agents exist', () => {
      const agents = ctx.db.prepare('SELECT name FROM agents ORDER BY name').all() as { name: string }[];
      const names = agents.map(a => a.name);
      expect(names).toContain('otcclaw');
      expect(names).toContain('admin');
    });

    it('otcclaw has standard tools_mode', () => {
      const row = ctx.db.prepare('SELECT tools_mode FROM agents WHERE name=?').get('otcclaw') as any;
      expect(row.tools_mode).toBe('standard');
    });

    it('agent IDs follow naming convention', () => {
      const agents = ctx.db.prepare('SELECT id, name FROM agents').all() as { id: string; name: string }[];
      for (const agent of agents) {
        expect(agent.id).toMatch(/^agent-/);
      }
    });
  });

  describe('runOnce idempotency', () => {
    it('user_aliases only constrains canonical_user_id', () => {
      const fks = ctx.db.prepare('PRAGMA foreign_key_list(user_aliases)').all() as { from: string; table: string }[];
      expect(fks.some(fk => fk.from === 'canonical_user_id' && fk.table === 'users')).toBe(true);
      expect(fks.some(fk => fk.from === 'alias_user_id')).toBe(false);
    });

    it('scheduled_tasks has a locked_until column', () => {
      const columns = ctx.db.prepare('PRAGMA table_info(scheduled_tasks)').all() as { name: string }[];
      expect(columns.map(c => c.name)).toContain('locked_until');
    });

    it('migrations table has entries', () => {
      const count = ctx.db.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number };
      expect(count.c).toBeGreaterThan(0);
    });

    it('running initSchema again does not duplicate migrations', async () => {
      const before = ctx.db.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number };
      const { initSchema } = await import('../../../src/db/schema.js');
      initSchema();
      const after = ctx.db.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number };
      expect(after.c).toBe(before.c);
    });

    it('running initSchema again does not duplicate agents', async () => {
      const before = ctx.db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
      const { initSchema } = await import('../../../src/db/schema.js');
      initSchema();
      const after = ctx.db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
      expect(after.c).toBe(before.c);
    });

    it('does not seed wework bot_apps from legacy WEWORK_AIBOT env vars', async () => {
      const oldBotId = process.env.WEWORK_AIBOT_BOT_ID;
      const oldSecret = process.env.WEWORK_AIBOT_SECRET;

      try {
        teardownDb();
        process.env.WEWORK_AIBOT_BOT_ID = 'legacy-env-wework-bot';
        process.env.WEWORK_AIBOT_SECRET = 'legacy-env-wework-secret';
        ctx = await setupUnitDb();

        const rows = ctx.db.prepare(`
          SELECT id, name
          FROM bot_apps
          WHERE channel = 'wework'
            AND (id = ? OR name = 'wework-bot')
        `).all('legacy-env-wework-bot') as Array<{ id: string; name: string }>;

        expect(rows).toEqual([]);
      } finally {
        if (oldBotId === undefined) delete process.env.WEWORK_AIBOT_BOT_ID;
        else process.env.WEWORK_AIBOT_BOT_ID = oldBotId;
        if (oldSecret === undefined) delete process.env.WEWORK_AIBOT_SECRET;
        else process.env.WEWORK_AIBOT_SECRET = oldSecret;
      }
    });

    it('does not seed business plugin scheduled tasks', () => {
      const row = ctx.db.prepare(`
        SELECT COUNT(*) as c
        FROM scheduled_tasks
        WHERE id IN (
          'etf-ticlaw-precalc',
          'etf-otcclaw-precalc',
          'fast-trading-summary-sync-otcclaw',
          '283ce632-45ab-468a-823b-90244bb12cad'
        )
      `).get() as { c: number };
      expect(row.c).toBe(0);
    });

    it('does not seed hardcoded Feishu bot apps', () => {
      const feishuApps = ctx.db.prepare('SELECT COUNT(*) as c FROM feishu_apps').get() as { c: number };
      const botApps = ctx.db.prepare(`
        SELECT COUNT(*) as c
        FROM bot_apps
        WHERE channel = 'feishu'
          OR id IN ('cli_a93212c0b7b9dcc5', 'cli_a9329f3af5b8dcc9')
          OR name IN ('otcclaw-bot', 'tutor-bot')
      `).get() as { c: number };

      expect(feishuApps.c).toBe(0);
      expect(botApps.c).toBe(0);
    });

    it('does not seed hardcoded TIClaw or WeWork test bot records', () => {
      const botApps = ctx.db.prepare(`
        SELECT COUNT(*) as c
        FROM bot_apps
        WHERE channel = 'wework'
          AND (
            id IN ('aibVpgqdRX0aRtfu0351LN-Ehtu9BVzSmMo', 'aib-l7p7MyNNEpadH2ELbHpZ0ozjczqiaWE')
            OR name IN ('ticlaw-bot', 'otcclaw-test-bot')
          )
      `).get() as { c: number };
      const assignments = ctx.db.prepare(`
        SELECT COUNT(*) as c
        FROM agent_assignments
        WHERE channel = 'wework'
          AND app_id IN ('aibVpgqdRX0aRtfu0351LN-Ehtu9BVzSmMo', 'aib-l7p7MyNNEpadH2ELbHpZ0ozjczqiaWE')
      `).get() as { c: number };

      expect(botApps.c).toBe(0);
      expect(assignments.c).toBe(0);
    });

    it('does not seed optional, private, or person-specific agents', () => {
      const row = ctx.db.prepare(`
        SELECT COUNT(*) as c
        FROM agents
        WHERE name IN ('alter-ego', 'doctor', 'tutor', 'browser', 'ticlaw', 'falcon', 'potato', 'man')
      `).get() as { c: number };

      expect(row.c).toBe(0);
    });

    it('does not seed hardcoded Feishu users or aliases', () => {
      const userIds = [
        'feishu_ou_d0076758ea8560d436638a7c78a8d26f',
        'feishu_ou_3a73e2e1bb61a5da577ba79eec33b00a',
        'feishu_ou_7e6c4bfcb6a25a9909bd2fe4e7ad3230',
        'feishu_ou_0e6cf7a054dc5629fa4bb4209236f292',
        'feishu_ou_b5fcfc05455cdca7c4f934b8443bbf9c',
        'feishu_ou_dad1044cedcb817cd0a4f96f7183b603',
      ];
      const placeholders = userIds.map(() => '?').join(', ');
      const users = ctx.db.prepare(`
        SELECT COUNT(*) as c
        FROM users
        WHERE id IN (${placeholders})
      `).get(...userIds) as { c: number };
      const aliases = ctx.db.prepare(`
        SELECT COUNT(*) as c
        FROM user_aliases
        WHERE canonical_user_id IN (${placeholders})
           OR alias_user_id IN (${placeholders})
           OR alias_user_id IN ('wework_gzxujun', 'wework_user_gzxujun', 'wework_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ', 'wework_user_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ')
      `).get(...userIds, ...userIds) as { c: number };

      expect(users.c).toBe(0);
      expect(aliases.c).toBe(0);
    });
  });

  describe('default users', () => {
    it('admin user exists', () => {
      const user = ctx.db.prepare("SELECT role FROM users WHERE username='admin'").get() as any;
      expect(user).toBeDefined();
      expect(user.role).toBe('admin');
    });
  });
});
