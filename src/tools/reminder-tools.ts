import Anthropic from '@anthropic-ai/sdk';
import type { SetReminderInput, CancelReminderInput } from '../llm/tool-types.js';
import { getCurrentAgent, type ToolContext, type DeliveryContext } from '../llm/agents/config.js';
import { createReminder, listReminders, cancelReminder } from '../commands/reminder.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'set_reminder',
    description: '设置一次性定时提醒。到时间后系统会主动向你发送提醒消息。可以用 remind_at 指定精确时间（ISO8601），或用 delay_minutes 指定延迟分钟数。',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: '提醒内容' },
        remind_at: { type: 'string', description: '提醒时间，ISO8601 格式，如 2026-03-20T15:30:00+08:00' },
        delay_minutes: { type: 'number', description: '从现在起延迟多少分钟后提醒' },
      },
      required: ['message'],
    },
  },
  {
    name: 'list_reminders',
    description: '列出当前 agent 所有待触发的提醒',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'cancel_reminder',
    description: '取消一个待触发的提醒',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '提醒 ID 或 ID 前缀（通过 list_reminders 获取）' },
      },
      required: ['id'],
    },
  },
];

function handleSetReminder(input: SetReminderInput, deliveryCtx?: DeliveryContext): string {
  if (!deliveryCtx) {
    return JSON.stringify({ error: '无法设置提醒：缺少投递上下文（deliveryContext）。请通过飞书或 Telegram 渠道使用此功能。' });
  }
  const agentId = getCurrentAgent()?.id ?? 'default';
  let remindAt: number;
  if (input.remind_at) {
    remindAt = new Date(input.remind_at).getTime();
    if (isNaN(remindAt)) return JSON.stringify({ error: `无效的时间格式: ${input.remind_at}` });
  } else if (input.delay_minutes != null) {
    remindAt = Date.now() + input.delay_minutes * 60_000;
  } else {
    return JSON.stringify({ error: '请提供 remind_at 或 delay_minutes' });
  }
  if (remindAt <= Date.now()) {
    return JSON.stringify({ error: '提醒时间必须在未来' });
  }
  const result = createReminder({
    agentId,
    message: input.message,
    remindAt,
    channel: deliveryCtx.channel,
    targetId: deliveryCtx.targetId,
    appId: deliveryCtx.appId,
  });
  const readableTime = new Date(remindAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return JSON.stringify({ ...result, remind_at: readableTime });
}

function handleListReminders(): string {
  const agentId = getCurrentAgent()?.id ?? 'default';
  const items = listReminders(agentId);
  if (items.length === 0) return JSON.stringify({ message: '暂无待触发的提醒' });
  return JSON.stringify(items.map(r => ({
    id: r.id.slice(0, 8),
    message: r.message,
    remind_at: new Date(r.remind_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    channel: r.channel,
  })));
}

function handleCancelReminder(input: CancelReminderInput): string {
  const agentId = getCurrentAgent()?.id ?? 'default';
  return JSON.stringify(cancelReminder(input.id, agentId));
}

export async function handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'set_reminder': return handleSetReminder(input, ctx?.deliveryContext);
    case 'list_reminders': return handleListReminders();
    case 'cancel_reminder': return handleCancelReminder(input);
    default: return null;
  }
}
