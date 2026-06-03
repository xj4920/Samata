# 定时提醒任务 (Reminder) Common Tools 设计方案

> 实现日期：2026-03-20

## 变更文件

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/commands/reminder.ts` | 新增 | createReminder / listReminders / cancelReminder |
| `src/services/reminder-scheduler.ts` | 新增 | startReminderScheduler / checkAndDeliver |
| `src/db/schema.ts` | 修改 | reminders 表 DDL + migration |
| `src/llm/tool-types.ts` | 修改 | SetReminderInput / ListRemindersInput / CancelReminderInput |
| `src/llm/agent.ts` | 修改 | 工具定义 + handlers + deliveryContext 透传 |
| `src/llm/agents/config.ts` | 修改 | TOOL_PRESETS['common'] 加入 3 个 reminder 工具 |
| `src/index.ts` | 修改 | 启动时调用 startReminderScheduler() |

## 核心设计

- DB 表 `reminders`: id, agent_id, message, remind_at(ms), status, channel, target_id, app_id, created_at
- 调度：setInterval 30s 轮询，发现 remind_at<=now AND status='pending' 则投递
- DeliveryContext 从 bot 层注入，经 runAgenticChat options → executeTool → set_reminder handler
- 投递实现：feishu 用 FeishuAPI.sendMessageTo，telegram 用 TelegramAPI.sendMessage，cli 用 console.log
