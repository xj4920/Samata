import { describe, it, expect } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('schedule tools', () => {
  const unit = useUnitDb();

  async function getAgentId(name: string): Promise<string> {
    const { getAgent } = await import('../../../src/llm/agents/config.js');
    return getAgent(name).id;
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
        payload: JSON.stringify({ tool_name: 'calc_etf_trades', input: {}, notify: false }),
        channel: 'system',
        createdBy: 'system',
      });

      expect(result.success).toBe(true);
      const tasks = listScheduledTasks(agentId);
      expect(tasks.some(t => t.name === 'ETF 预计算' && t.task_type === 'tool_call')).toBe(true);
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

    it('executes due tool_call tasks in the scheduled agent context', async () => {
      const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
      const { checkAndExecute } = await import('../../../src/services/task-scheduler.js');
      const agentId = await getAgentId('otcclaw');

      const created = createScheduledTask({
        agentId,
        name: 'due ETF 预计算',
        cronExpr: '0 18 * * 1-5',
        taskType: 'tool_call',
        payload: JSON.stringify({ tool_name: 'calc_etf_trades', input: {}, notify: false }),
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
      expect(parsed).toEqual({ ok: true, agentId, channel: 'system', input: {} });
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
        payload: JSON.stringify({ tool_name: 'calc_etf_trades', input: {}, notify: false }),
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
