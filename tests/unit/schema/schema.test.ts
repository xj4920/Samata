import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupUnitDb, teardownDb, type UnitTestContext } from '../../helpers/unit-harness.js';

describe('schema integrity', () => {
  let ctx: UnitTestContext;

  beforeEach(async () => {
    ctx = await setupUnitDb();
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
    it('all 4 default agents exist', () => {
      const agents = ctx.db.prepare('SELECT name FROM agents ORDER BY name').all() as { name: string }[];
      const names = agents.map(a => a.name);
      expect(names).toContain('otcclaw');
      expect(names).toContain('alter-ego');
      expect(names).toContain('doctor');
      expect(names).toContain('tutor');
    });

    it('otcclaw has standard tools_mode', () => {
      const row = ctx.db.prepare('SELECT tools_mode FROM agents WHERE name=?').get('otcclaw') as any;
      expect(row.tools_mode).toBe('standard');
    });

    it('alter-ego has all tools_mode', () => {
      const row = ctx.db.prepare('SELECT tools_mode FROM agents WHERE name=?').get('alter-ego') as any;
      expect(row.tools_mode).toBe('all');
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
  });

  describe('default users', () => {
    it('admin user exists', () => {
      const user = ctx.db.prepare("SELECT role FROM users WHERE username='admin'").get() as any;
      expect(user).toBeDefined();
      expect(user.role).toBe('admin');
    });
  });
});
