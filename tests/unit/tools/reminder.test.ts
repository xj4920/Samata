import { describe, it, expect } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('reminder tools', () => {
  const unit = useUnitDb();

  async function getAgentId(name: string): Promise<string> {
    const { getAgent } = await import('../../../src/llm/agents/config.js');
    return getAgent(name).id;
  }

  describe('command layer (createReminder / listReminders / cancelReminder)', () => {
    it('creates and lists reminders', async () => {
      const { createReminder, listReminders } = await import('../../../src/commands/reminder.js');
      const agentId = await getAgentId('admin');

      const result = createReminder({
        agentId,
        message: '提醒测试',
        remindAt: Date.now() + 3600000,
        channel: 'cli',
        targetId: 'test-user',
      });
      expect(result.success).toBe(true);

      const list = listReminders(agentId);
      expect(list.length).toBe(1);
      expect(list[0].message).toBe('提醒测试');
      expect(list[0].status).toBe('pending');
    });

    it('cancels a reminder', async () => {
      const { createReminder, cancelReminder, listReminders } = await import('../../../src/commands/reminder.js');
      const agentId = await getAgentId('admin');

      const created = createReminder({
        agentId,
        message: '即将取消',
        remindAt: Date.now() + 3600000,
        channel: 'cli',
        targetId: 'test-user',
      });
      expect(created.success).toBe(true);
      const { id } = created as { success: true; id: string };

      const cancel = cancelReminder(id.slice(0, 8), agentId);
      expect(cancel.success).toBe(true);

      const list = listReminders(agentId);
      expect(list.every(r => r.status === 'cancelled')).toBe(true);
    });

    it('getPendingReminders returns only past-due pending reminders', async () => {
      const { createReminder, getPendingReminders } = await import('../../../src/commands/reminder.js');
      const agentId = await getAgentId('admin');

      createReminder({
        agentId,
        message: 'past due',
        remindAt: Date.now() - 1000,
        channel: 'cli',
        targetId: 'test-user',
      });
      createReminder({
        agentId,
        message: 'future',
        remindAt: Date.now() + 3600000,
        channel: 'cli',
        targetId: 'test-user',
      });

      const pending = getPendingReminders();
      expect(pending.length).toBe(1);
      expect(pending[0].message).toBe('past due');
    });
  });

  describe('tool handler requires deliveryContext', () => {
    it('returns error without deliveryContext', async () => {
      const reminderTools = await import('../../../src/tools/reminder-tools.js');

      const result = await withContext({ agentName: 'admin' }, () =>
        reminderTools.handleTool('set_reminder', {
          message: '无context',
          remind_at: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.error).toBeTruthy();
    });

    it('list_reminders via handleTool works', async () => {
      const reminderTools = await import('../../../src/tools/reminder-tools.js');

      const result = await withContext({ agentName: 'admin' }, () =>
        reminderTools.handleTool('list_reminders', {}),
      );
      expect(result).toBeTruthy();
    });

    it('persists Feishu group chat delivery context for reminders', async () => {
      const reminderTools = await import('../../../src/tools/reminder-tools.js');

      const result = await withContext({ agentName: 'admin' }, () =>
        reminderTools.handleTool('set_reminder', {
          message: '群提醒',
          delay_minutes: 5,
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
        'SELECT channel, target_id, app_id FROM reminders WHERE message = ?',
      ).get('群提醒') as { channel: string; target_id: string; app_id: string };
      expect(row).toEqual({
        channel: 'feishu',
        target_id: 'oc_group_chat',
        app_id: 'cli_test_app',
      });
    });
  });
});
