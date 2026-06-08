---
docModules:
  - platform
  - permissions
docTopics:
  platform: 调度与任务
  permissions: Agent 权限
canonicalDocs:
  - /platform/common-tools
  - /permissions/tool-access
status: implemented
---

# Doctor agent_chat 定时任务修复（2026-06-08）

## 背景

doctor 的 08:00 健康播报原本被创建为 `remind` 类型，调度器只会投递固定提醒文案，不会运行 doctor 的查询、分析和最终播报流程。

## 决策

- 保留 `remind` 作为纯提醒语义。
- 新增 `agent_chat` 定时任务类型，用于周期性执行当前 agent prompt，并把最终回复推送到原渠道。
- doctor 08:00 健康播报应使用 `agent_chat`，而不是系统 crontab 或 `remind`。

## 改动

- `scheduled_tasks.task_type` 支持 `agent_chat`，并增加旧库 CHECK 约束迁移。
- `create_scheduled_task` 工具声明同步支持 `agent_chat`。
- `task-scheduler` 新增 `agent_chat` 执行分支，按任务保存的 agent、创建人和投递上下文运行 `runAgenticChat`，再推送最终回复。
- 新增单测覆盖 `agent_chat` 创建、payload 校验、调度执行和投递。

## 验证

- `npx tsc --noEmit`
- `npx vitest run tests/unit/tools/schedule.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts`
- `npx vitest run tests/unit/schema/schema.test.ts`
- `git diff --check`

## 运行状态

- 已将 doctor 的 `每日健康播报-完整流程-08:00` 更新为 `agent_chat`。
- 下次执行时间：`2026-06-07 08:00:00`（Asia/Shanghai，当时数据库状态）。
- 数据库备份：`data/samata.db.bak-agent-chat-20260606085216-file`。
