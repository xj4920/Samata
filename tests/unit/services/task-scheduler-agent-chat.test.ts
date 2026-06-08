import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useUnitDb } from '../../helpers/unit-harness.js';

const mockRunAgenticChat = vi.hoisted(() => vi.fn());
const mockDeliverMessage = vi.hoisted(() => vi.fn());

vi.mock('../../../src/llm/agent.js', () => ({
  runAgenticChat: mockRunAgenticChat,
}));

vi.mock('../../../src/services/deliver.js', () => ({
  deliverMessage: mockDeliverMessage,
}));

describe('task scheduler agent_chat tasks', () => {
  const unit = useUnitDb();

  beforeEach(() => {
    mockRunAgenticChat.mockReset();
    mockDeliverMessage.mockReset();
  });

  it('runs the scheduled agent prompt and delivers the final reply', async () => {
    mockRunAgenticChat.mockResolvedValue('每日健康播报结果');
    mockDeliverMessage.mockResolvedValue(true);

    const { createScheduledTask } = await import('../../../src/commands/scheduled-task.js');
    const { checkAndExecute } = await import('../../../src/services/task-scheduler.js');
    const { getAgent } = await import('../../../src/llm/agents/config.js');

    const agent = getAgent('doctor');
    const created = createScheduledTask({
      agentId: agent.id,
      name: '每日健康播报',
      cronExpr: '0 8 * * *',
      taskType: 'agent_chat',
      payload: JSON.stringify({ prompt: '请生成每日健康播报' }),
      channel: 'feishu',
      targetId: 'oc_group_chat',
      appId: 'cli_app',
      createdBy: 'test-user',
    });
    expect(created.success).toBe(true);

    const idPrefix = (created as any).id;
    const task = unit.db.prepare('SELECT id FROM scheduled_tasks WHERE id LIKE ?').get(`${idPrefix}%`) as { id: string };
    unit.db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, task.id);

    await checkAndExecute();

    expect(mockRunAgenticChat).toHaveBeenCalledTimes(1);
    const [, prompt, user, options] = mockRunAgenticChat.mock.calls[0];
    expect(prompt).toBe('请生成每日健康播报');
    expect(user.id).toBe('test-user');
    expect(options.agentConfig.name).toBe('doctor');
    expect(options.deliveryContext).toEqual({
      channel: 'feishu',
      targetId: 'oc_group_chat',
      appId: 'cli_app',
    });

    expect(mockDeliverMessage).toHaveBeenCalledWith(
      'feishu',
      'oc_group_chat',
      'cli_app',
      '每日健康播报结果',
      '[task-scheduler]',
    );

    const row = unit.db.prepare(
      'SELECT last_run_at, last_result, next_run_at FROM scheduled_tasks WHERE id = ?',
    ).get(task.id) as { last_run_at: number | null; last_result: string | null; next_run_at: number | null };
    expect(row.last_run_at).toBeGreaterThan(0);
    expect(row.last_result).toBe('每日健康播报结果');
    expect(row.next_run_at).toBeGreaterThan(Date.now());
  });
});
