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
      'agents', 'agent_members', 'todos', 'health_records',
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

    it('seeds ETF precompute scheduled tasks idempotently', async () => {
      const rows = ctx.db.prepare(`
        SELECT st.id, a.name AS agent_name, st.cron_expr, st.task_type, st.payload, st.channel, st.created_by
        FROM scheduled_tasks st
        JOIN agents a ON a.id = st.agent_id
        WHERE st.id IN ('etf-ticlaw-precalc', 'etf-otcclaw-precalc')
        ORDER BY a.name
      `).all() as Array<{
        id: string;
        agent_name: string;
        cron_expr: string;
        task_type: string;
        payload: string;
        channel: string;
        created_by: string;
      }>;

      expect(rows).toHaveLength(2);
      expect(rows.map(r => r.agent_name)).toEqual(['otcclaw', 'ticlaw']);
      for (const row of rows) {
        expect(row.cron_expr).toBe('0 18 * * 1-5');
        expect(row.task_type).toBe('tool_call');
        expect(row.channel).toBe('system');
        expect(row.created_by).toBe('system');
        expect(JSON.parse(row.payload)).toEqual({ tool_name: 'calc_etf_trades', input: { force: true }, notify: false });
      }

      const { initSchema } = await import('../../../src/db/schema.js');
      initSchema();
      const after = ctx.db.prepare(`
        SELECT COUNT(*) as c
        FROM scheduled_tasks
        WHERE id IN ('etf-ticlaw-precalc', 'etf-otcclaw-precalc')
      `).get() as { c: number };
      expect(after.c).toBe(2);
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
