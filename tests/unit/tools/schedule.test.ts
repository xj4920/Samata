import { describe, it, expect } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('schedule tools', () => {
  const unit = useUnitDb();

  async function getAgentId(name: string): Promise<string> {
    const { getAgent } = await import('../../../src/llm/agents/config.js');
    return getAgent(name).id;
  }

  async function bindAgentTools(agentName: string, tools: string[]): Promise<void> {
    const { applyAgentToolBinding } = await import('../../../src/llm/agents/tool-binding.js');
    const result = await withContext({ channel: 'cli', role: 'admin', agentName }, () =>
      applyAgentToolBinding({ agentName, addTools: tools }),
    );
    expect(result.success).toBe(true);
  }

  describe('command layer', () => {
    it('creates and lists tasks', async () => {
      const { createScheduledTask, listScheduledTasks } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('alter-ego');

      const result = createScheduledTask({
        agentId,
        name: '测试定时任务',
        cronExpr: '0 9 * * 1-5',
        taskType: 'remind',
        payload: JSON.stringify({ message: '每日提醒' }),
        channel: 'cli',
        targetId: 'test-user',
      });
      expect(result.success).toBe(true);
      expect((result as any).id).toBeTruthy();

      const tasks = listScheduledTasks(agentId);
      expect(tasks.length).toBe(1);
      expect(tasks[0].name).toBe('测试定时任务');
    });

    it('creates tool_call tasks with the ETF payload', async () => {
      const { createScheduledTask, listScheduledTasks } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('otcclaw');

      const result = createScheduledTask({
        agentId,
        name: 'ETF 预计算',
        cronExpr: '0 18 * * 1-5',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'calc_etf_trades', input: { force: true }, notify: false }),
        channel: 'system',
        createdBy: 'system',
      });

      expect(result.success).toBe(true);
      const tasks = listScheduledTasks(agentId);
      expect(tasks.some(t => t.name === 'ETF 预计算' && t.task_type === 'tool_call')).toBe(true);
    });

    it('creates agent_chat tasks with a prompt payload', async () => {
      const { createScheduledTask, listScheduledTasks } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('doctor');

      const result = createScheduledTask({
        agentId,
        name: '每日健康播报',
        cronExpr: '0 8 * * *',
        taskType: 'agent_chat',
        payload: JSON.stringify({ prompt: '请生成每日健康播报' }),
        channel: 'feishu',
        targetId: 'oc_group_chat',
        appId: 'cli_app',
        createdBy: 'test-user',
      });

      expect(result.success).toBe(true);
      const tasks = listScheduledTasks(agentId);
      expect(tasks.some(t => t.name === '每日健康播报' && t.task_type === 'agent_chat')).toBe(true);

      const invalid = createScheduledTask({
        agentId,
        name: 'bad agent chat',
        cronExpr: '0 8 * * *',
        taskType: 'agent_chat',
        payload: JSON.stringify({ message: '' }),
        channel: 'feishu',
      });
      expect(invalid.success).toBe(false);
    });

    it('accepts empty or force-only ETF tool_call input', async () => {
      const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('otcclaw');

      const emptyInput = createScheduledTask({
        agentId,
        name: 'ETF 预计算 empty input',
        cronExpr: '0 18 * * 1-5',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'calc_etf_trades', input: {}, notify: false }),
        channel: 'system',
        createdBy: 'system',
      });
      expect(emptyInput.success).toBe(true);

      const forceInput = createScheduledTask({
        agentId,
        name: 'ETF 预计算 force input',
        cronExpr: '0 18 * * 1-5',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'calc_etf_trades', input: { force: true }, notify: false }),
        channel: 'system',
        createdBy: 'system',
      });
      expect(forceInput.success).toBe(true);
    });

    it('accepts trading summary sync tool_call input', async () => {
      const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('otcclaw');

      const emptyInput = createScheduledTask({
        agentId,
        name: '极速 summary 同步',
        cronExpr: '30 18 * * *',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'sync_fast_trading_summary', input: {}, notify: false }),
        channel: 'system',
        createdBy: 'system',
      });
      expect(emptyInput.success).toBe(true);

      const rangedInput = createScheduledTask({
        agentId,
        name: '极速 summary 回填',
        cronExpr: '30 18 * * *',
        taskType: 'tool_call',
        payload: JSON.stringify({
          tool_name: 'sync_fast_trading_summary',
          input: { date_from: '20260601', date_to: '20260602', force: true, keep_raw: false },
          notify: false,
        }),
        channel: 'system',
        createdBy: 'system',
      });
      expect(rangedInput.success).toBe(true);

      const normalTradingInput = createScheduledTask({
        agentId,
        name: '常速业务规模同步',
        cronExpr: '0 19 * * 1-5',
        taskType: 'tool_call',
        payload: JSON.stringify({
          tool_name: 'sync_normal_trading_summary',
          input: { date_from: '20260601', date_to: '20260602', force: true, keep_raw: false },
          notify: false,
        }),
        channel: 'wework',
        createdBy: 'system',
      });
      expect(normalTradingInput.success).toBe(true);
    });

    it('rejects invalid tool_call payload', async () => {
      const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('otcclaw');

      const result = createScheduledTask({
        agentId,
        name: 'bad tool call',
        cronExpr: '0 18 * * 1-5',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'query_etf_summary', input: {}, notify: false }),
        channel: 'system',
        createdBy: 'system',
      });

      expect(result.success).toBe(false);
    });

    it('updates a task (disable)', async () => {
      const { createScheduledTask, updateScheduledTask, listScheduledTasks } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('alter-ego');

      const created = createScheduledTask({
        agentId,
        name: '待禁用',
        cronExpr: '0 9 * * *',
        taskType: 'remind',
        payload: JSON.stringify({ message: 'test' }),
        channel: 'cli',
      });
      expect(created.success).toBe(true);
      const taskId = (created as any).id;

      const updated = updateScheduledTask(taskId.slice(0, 8), agentId, { enabled: false });
      expect(updated.success).toBe(true);

      const tasks = listScheduledTasks(agentId);
      expect(tasks[0].enabled).toBe(0);
    });

    it('deletes a task', async () => {
      const { createScheduledTask, deleteScheduledTask, listScheduledTasks } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('alter-ego');

      const created = createScheduledTask({
        agentId,
        name: '待删除',
        cronExpr: '0 9 * * *',
        taskType: 'remind',
        payload: JSON.stringify({ message: 'test' }),
        channel: 'cli',
      });
      expect(created.success).toBe(true);
      const taskId = (created as any).id;

      const deleted = deleteScheduledTask(taskId.slice(0, 8), agentId);
      expect(deleted.success).toBe(true);

      const tasks = listScheduledTasks(agentId);
      expect(tasks.length).toBe(0);
    });

    it('invalid cron expr fails', async () => {
      const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('alter-ego');

      const result = createScheduledTask({
        agentId,
        name: '无效cron',
        cronExpr: 'invalid',
        taskType: 'remind',
        payload: JSON.stringify({ message: 'test' }),
        channel: 'cli',
      });
      expect(result.success).toBe(false);
    });

    it('tasks are agent-scoped', async () => {
      const { createScheduledTask, listScheduledTasks } = await import('../../../src/commands/scheduled-task.js');
      const agentId1 = await getAgentId('alter-ego');
      const agentId2 = await getAgentId('doctor');

      createScheduledTask({
        agentId: agentId1,
        name: 'ego-task',
        cronExpr: '0 9 * * *',
        taskType: 'remind',
        payload: JSON.stringify({ message: 'test' }),
        channel: 'cli',
      });

      expect(listScheduledTasks(agentId1).length).toBe(1);
      expect(listScheduledTasks(agentId2).length).toBe(0);
    });

    it('claims a due task only once until the lock expires', async () => {
      const { createScheduledTask, claimDueScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('alter-ego');

      const created = createScheduledTask({
        agentId,
        name: 'claim once',
        cronExpr: '0 9 * * *',
        taskType: 'remind',
        payload: JSON.stringify({ message: 'test' }),
        channel: 'cli',
      });
      expect(created.success).toBe(true);

      const idPrefix = (created as any).id;
      const task = unit.db.prepare('SELECT id FROM scheduled_tasks WHERE id LIKE ?').get(`${idPrefix}%`) as { id: string };
      const now = Date.now();
      unit.db.prepare('UPDATE scheduled_tasks SET next_run_at = ?, locked_until = NULL WHERE id = ?').run(now - 1000, task.id);

      const first = claimDueScheduledTask(task.id, 1000, now);
      expect(first?.id).toBe(task.id);
      expect(first?.locked_until).toBe(now + 1000);
      expect(claimDueScheduledTask(task.id, 1000, now + 1)).toBeNull();

      unit.db.prepare('UPDATE scheduled_tasks SET locked_until = ? WHERE id = ?').run(now - 1, task.id);
      const afterExpiry = claimDueScheduledTask(task.id, 1000, now);
      expect(afterExpiry?.id).toBe(task.id);
    });

    it('markTaskExecuted clears the lock and advances next_run_at', async () => {
      const { createScheduledTask, markTaskExecuted } = await import('../../../src/commands/scheduled-task.js');
      const agentId = await getAgentId('alter-ego');

      const created = createScheduledTask({
        agentId,
        name: 'clear lock',
        cronExpr: '0 9 * * *',
        taskType: 'remind',
        payload: JSON.stringify({ message: 'test' }),
        channel: 'cli',
      });
      expect(created.success).toBe(true);

      const idPrefix = (created as any).id;
      const task = unit.db.prepare('SELECT id FROM scheduled_tasks WHERE id LIKE ?').get(`${idPrefix}%`) as { id: string };
      const nextRunAt = Date.now() + 60_000;
      unit.db.prepare('UPDATE scheduled_tasks SET locked_until = ? WHERE id = ?').run(Date.now() + 60_000, task.id);

      markTaskExecuted(task.id, 'ok', nextRunAt);

      const row = unit.db.prepare(
        'SELECT last_run_at, last_result, next_run_at, locked_until FROM scheduled_tasks WHERE id = ?',
      ).get(task.id) as { last_run_at: number | null; last_result: string | null; next_run_at: number | null; locked_until: number | null };
      expect(row.last_run_at).toBeGreaterThan(0);
      expect(row.last_result).toBe('ok');
      expect(row.next_run_at).toBe(nextRunAt);
      expect(row.locked_until).toBeNull();
    });

    it('executes due tool_call tasks in the scheduled agent context', async () => {
      const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const { checkAndExecute } = await import('../../../src/services/task-scheduler.js');
      const agentId = await getAgentId('otcclaw');
      await bindAgentTools('otcclaw', ['calc_etf_trades']);

      const created = createScheduledTask({
        agentId,
        name: 'due ETF 预计算',
        cronExpr: '0 18 * * 1-5',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'calc_etf_trades', input: { force: true }, notify: false }),
        channel: 'system',
        createdBy: 'system',
      });
      expect(created.success).toBe(true);

      const idPrefix = (created as any).id;
      const task = unit.db.prepare('SELECT id FROM scheduled_tasks WHERE id LIKE ?').get(`${idPrefix}%`) as { id: string };
      unit.db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, task.id);

      await checkAndExecute();

      const row = unit.db.prepare(
        'SELECT last_run_at, last_result, next_run_at FROM scheduled_tasks WHERE id = ?',
      ).get(task.id) as { last_run_at: number | null; last_result: string | null; next_run_at: number | null };
      expect(row.last_run_at).toBeGreaterThan(0);
      expect(row.next_run_at).toBeGreaterThan(Date.now());
      const parsed = JSON.parse(row.last_result!);
      expect(parsed).toEqual({ ok: true, agentId, channel: 'system', isAdmin: true, input: { force: true } });
    });

    it('executes due FastTrading sync tasks in the scheduled agent context', async () => {
      const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const { checkAndExecute } = await import('../../../src/services/task-scheduler.js');
      const agentId = await getAgentId('otcclaw');
      await bindAgentTools('otcclaw', ['sync_fast_trading_summary']);

      const created = createScheduledTask({
        agentId,
        name: 'due 极速 summary 同步',
        cronExpr: '30 18 * * *',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'sync_fast_trading_summary', input: {}, notify: false }),
        channel: 'system',
        createdBy: 'system',
      });
      expect(created.success).toBe(true);

      const idPrefix = (created as any).id;
      const task = unit.db.prepare('SELECT id FROM scheduled_tasks WHERE id LIKE ?').get(`${idPrefix}%`) as { id: string };
      unit.db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, task.id);

      await checkAndExecute();

      const row = unit.db.prepare(
        'SELECT last_run_at, last_result, next_run_at FROM scheduled_tasks WHERE id = ?',
      ).get(task.id) as { last_run_at: number | null; last_result: string | null; next_run_at: number | null };
      expect(row.last_run_at).toBeGreaterThan(0);
      expect(row.next_run_at).toBeGreaterThan(Date.now());
      const parsed = JSON.parse(row.last_result!);
      expect(parsed).toEqual({ ok: true, tool: 'sync_fast_trading_summary', agentId, channel: 'system', isAdmin: true, input: {} });
    });

    it('executes due NormalTrading sync tasks in the scheduled agent context', async () => {
      const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const { checkAndExecute } = await import('../../../src/services/task-scheduler.js');
      const agentId = await getAgentId('otcclaw');
      await bindAgentTools('otcclaw', ['sync_normal_trading_summary']);

      const created = createScheduledTask({
        agentId,
        name: 'due 常速业务规模同步',
        cronExpr: '0 19 * * 1-5',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'sync_normal_trading_summary', input: {}, notify: false }),
        channel: 'wework',
        createdBy: 'system',
      });
      expect(created.success).toBe(true);

      const idPrefix = (created as any).id;
      const task = unit.db.prepare('SELECT id FROM scheduled_tasks WHERE id LIKE ?').get(`${idPrefix}%`) as { id: string };
      unit.db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, task.id);

      await checkAndExecute();

      const row = unit.db.prepare(
        'SELECT last_run_at, last_result, next_run_at FROM scheduled_tasks WHERE id = ?',
      ).get(task.id) as { last_run_at: number | null; last_result: string | null; next_run_at: number | null };
      expect(row.last_run_at).toBeGreaterThan(0);
      expect(row.next_run_at).toBeGreaterThan(Date.now());
      const parsed = JSON.parse(row.last_result!);
      expect(parsed).toEqual({ ok: true, tool: 'sync_normal_trading_summary', agentId, channel: 'system', isAdmin: true, input: {} });
    });
  });

  describe('tool handler requires deliveryContext', () => {
    it('returns error without deliveryContext', async () => {
      const scheduleTools = await import('../../../src/tools/schedule-tools.js');

      const result = await withContext({ agentName: 'alter-ego' }, () =>
        scheduleTools.handleTool('create_scheduled_task', {
          name: 'no-ctx',
          cron_expr: '0 9 * * *',
          task_type: 'remind',
          payload: JSON.stringify({ message: 'test' }),
        }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.error).toBeTruthy();
    });

    it('shows system-created scheduled tasks for the current agent', async () => {
      const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const scheduleTools = await import('../../../src/tools/schedule-tools.js');
      const agentId = await getAgentId('alter-ego');

      const systemTask = createScheduledTask({
        agentId,
        name: 'system-visible',
        cronExpr: '0 18 * * 1-5',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'calc_etf_trades', input: { force: true }, notify: false }),
        channel: 'system',
        createdBy: 'system',
      });
      expect(systemTask.success).toBe(true);

      const listed = await withContext({ agentName: 'alter-ego' }, () =>
        scheduleTools.handleTool('list_scheduled_tasks', {}),
      );
      const parsed = JSON.parse(listed!);
      expect(parsed.map((task: any) => task.name)).toContain('system-visible');

      const updated = await withContext({ agentName: 'alter-ego' }, () =>
        scheduleTools.handleTool('update_scheduled_task', {
          id: (systemTask as any).id,
          enabled: false,
        }),
      );
      expect(JSON.parse(updated!).success).toBe(true);
    });

    it('persists Feishu group chat delivery context for scheduled tasks', async () => {
      const scheduleTools = await import('../../../src/tools/schedule-tools.js');

      const result = await withContext({ agentName: 'alter-ego' }, () =>
        scheduleTools.handleTool('create_scheduled_task', {
          name: '群定时任务',
          cron_expr: '0 8 * * *',
          task_type: 'remind',
          payload: JSON.stringify({ message: '早报' }),
        }, {
          deliveryContext: {
            channel: 'feishu',
            targetId: 'oc_group_chat',
            appId: 'cli_test_app',
          },
        }),
      );

      expect(JSON.parse(result!).success).toBe(true);
      const row = unit.db.prepare(
        'SELECT channel, target_id, app_id FROM scheduled_tasks WHERE name = ?',
      ).get('群定时任务') as { channel: string; target_id: string; app_id: string };
      expect(row).toEqual({
        channel: 'feishu',
        target_id: 'oc_group_chat',
        app_id: 'cli_test_app',
      });
    });

    it('requires agent admin to create, update, and delete scheduled tasks', async () => {
      const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const scheduleTools = await import('../../../src/tools/schedule-tools.js');
      const agentId = await getAgentId('otcclaw');
      const input = {
        name: 'admin-only scheduled task',
        cron_expr: '0 19 * * 1-5',
        task_type: 'tool_call',
        payload: JSON.stringify({ tool_name: 'sync_fast_trading_summary', input: {}, notify: false }),
      };
      const deliveryContext = { channel: 'wework', targetId: 'room-1' };

      const deniedCreate = await withContext({ channel: 'wework', role: 'user', agentName: 'otcclaw' }, () =>
        scheduleTools.handleTool('create_scheduled_task', input, { deliveryContext }),
      );
      expect(JSON.parse(deniedCreate!).error).toContain('agent admin');

      const existing = createScheduledTask({
        agentId,
        name: 'existing',
        cronExpr: '0 18 * * 1-5',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'sync_fast_trading_summary', input: {}, notify: false }),
        channel: 'system',
        createdBy: 'system',
      });
      expect(existing.success).toBe(true);

      const deniedUpdate = await withContext({ channel: 'wework', role: 'user', agentName: 'otcclaw' }, () =>
        scheduleTools.handleTool('update_scheduled_task', { id: (existing as any).id, enabled: false }),
      );
      expect(JSON.parse(deniedUpdate!).error).toContain('agent admin');

      const deniedDelete = await withContext({ channel: 'wework', role: 'user', agentName: 'otcclaw' }, () =>
        scheduleTools.handleTool('delete_scheduled_task', { id: (existing as any).id }),
      );
      expect(JSON.parse(deniedDelete!).error).toContain('agent admin');

      unit.db.prepare(
        `INSERT INTO agent_members (id, agent_id, user_id, role, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run('am-test-user-otc-schedule', agentId, 'test-user', 'admin');

      const created = await withContext({ channel: 'wework', role: 'user', agentName: 'otcclaw' }, () =>
        scheduleTools.handleTool('create_scheduled_task', input, { deliveryContext }),
      );
      const parsedCreated = JSON.parse(created!);
      expect(parsedCreated.success).toBe(true);

      const updated = await withContext({ channel: 'wework', role: 'user', agentName: 'otcclaw' }, () =>
        scheduleTools.handleTool('update_scheduled_task', { id: parsedCreated.id, enabled: false }),
      );
      expect(JSON.parse(updated!).success).toBe(true);

      const deleted = await withContext({ channel: 'wework', role: 'user', agentName: 'otcclaw' }, () =>
        scheduleTools.handleTool('delete_scheduled_task', { id: parsedCreated.id }),
      );
      expect(JSON.parse(deleted!).success).toBe(true);
    });
  });

  describe('agent-owned crontab helpers', () => {
    it('lists only entries owned by the selected agent', async () => {
      const {
        formatAgentCrontabMarker,
        listOwnedCrontabEntries,
      } = await import('../../../src/tools/schedule-tools.js');
      const raw = [
        '# system backup',
        '0 1 * * * /usr/bin/system-backup',
        formatAgentCrontabMarker({ id: 'agent-a', name: 'a' }, 'own job'),
        '0 2 * * * /usr/bin/own-job',
        formatAgentCrontabMarker({ id: 'agent-b', name: 'b' }, 'other job'),
        '0 3 * * * /usr/bin/other-job',
        '',
      ].join('\n');

      expect(listOwnedCrontabEntries(raw, 'agent-a')).toEqual([
        {
          comment: 'own job',
          schedule: '0 2 * * *',
          command: '/usr/bin/own-job',
          raw: '0 2 * * * /usr/bin/own-job',
        },
      ]);
    });

    it('removes only matching entries owned by the selected agent', async () => {
      const {
        formatAgentCrontabMarker,
        removeOwnedCrontabEntries,
      } = await import('../../../src/tools/schedule-tools.js');
      const raw = [
        '# system backup',
        '0 1 * * * /usr/bin/system-backup',
        formatAgentCrontabMarker({ id: 'agent-a', name: 'a' }, 'own job'),
        '0 2 * * * /usr/bin/own-job',
        formatAgentCrontabMarker({ id: 'agent-b', name: 'b' }, 'other job'),
        '0 3 * * * /usr/bin/other-job',
        '',
      ].join('\n');

      const otherResult = removeOwnedCrontabEntries(raw, 'agent-a', 'other-job');
      expect(otherResult.removed).toBe(0);
      expect(otherResult.updated).toBe(raw);

      const ownResult = removeOwnedCrontabEntries(raw, 'agent-a', 'own-job');
      expect(ownResult.removed).toBe(1);
      expect(ownResult.updated).not.toContain('/usr/bin/own-job');
      expect(ownResult.updated).toContain('/usr/bin/system-backup');
      expect(ownResult.updated).toContain('/usr/bin/other-job');
    });
  });
});
