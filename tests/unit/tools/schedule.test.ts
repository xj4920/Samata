import { describe, it, expect } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('schedule tools', () => {
  useUnitDb();

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
  });
});
