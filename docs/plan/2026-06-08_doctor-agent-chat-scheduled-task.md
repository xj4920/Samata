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

## 2026-06-08 发送行为修正（二次修订）

### 背景

doctor 定时健康播报执行后，群里同时出现了 Markdown 文件附件和一条未渲染的 Markdown 纯文本消息。附件来自定时 `agent_chat` 运行时暴露了当前渠道的 `deliveryContext`，模型可以继续调用 `send_file`；未渲染则是飞书投递路径使用了 `text` 消息类型。

第一次修正曾尝试在平台层对 doctor 定时 `agent_chat` 禁用 `send_file`。该方案过于侵入，会改变定时任务里 agent tools 的通用能力；最终改为只通过当前定时任务的 prompt 引导 doctor 不发送 Markdown 文件附件，并自然调用 Codex 图片生成工具。

### 决策

- 保留 `send_file` 完整能力，不在 Samata 平台代码中固化 doctor 专属流程。
- 不新增 `doctor + task name` 的硬编码后处理，也不由调度器主动调用 `generate_image_codex` 或 `send_image`。
- 飞书最终投递和插件通知统一改为 interactive markdown card；若 card 发送失败，再降级为普通 text，避免消息丢失。
- 当前 doctor 08:00 定时任务通过 `payload.prompt` 引导：不要发送 `.md` 正文附件，基于正文调用 `generate_image_codex` 生成健康播报信息海报，再调用 `send_image` 发送图片，最后返回同一份 Markdown 正文。

### 改动

- 撤销 `runAgenticChat.disabledTools` 和 `task-scheduler` 中的 doctor 定时禁用 `send_file` 特例。
- `deliverMessage` 的飞书路径改发 markdown card，插件 `sendNotification` 的飞书路径同步改造。
- 新增 `src/feishu/markdown-card.ts` 复用飞书 markdown card 内容结构。
- 更新当前运行库中 `每日健康播报-完整流程-08:00` 的 `payload.prompt`，加入 `generate_image_codex` / `send_image` 的自然语言引导。
- 更新前通过 SQLite `.backup` 生成数据库备份：`data/samata.db.bak-doctor-prompt-20260608`。
- 更新单测覆盖飞书 markdown card，并确认 doctor 定时任务不再带平台层工具禁用。

### 验证

- `npx vitest run tests/unit/services/deliver.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts tests/unit/plugins/registry-delivery.test.ts`
- `npx tsc --noEmit`
- `git diff --check`
- 只读 SQL 确认 doctor 08:00 定时任务 prompt 已包含 `generate_image_codex`、`send_image`，且没有平台层工具禁用配置。
