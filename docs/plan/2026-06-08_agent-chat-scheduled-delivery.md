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

# Agent Chat 定时任务与 Markdown 投递修复（2026-06-08）

## 背景

平台已有 `remind` 定时任务可按 cron 推送固定文案，但无法周期性运行当前 agent 的查询、分析和最终回复流程。对于需要让 agent 定期执行完整 prompt 的场景，应使用独立的 `agent_chat` 任务类型。

后续运行验证发现，部分定时播报场景会出现两类发送问题：

- 最终回复通过飞书 `text` 消息发送时，Markdown 不会渲染。
- 若 prompt 引导不清晰，agent 可能把 Markdown 正文写成 `.md` 附件并调用 `send_file` 发送。

## 决策

- 保留 `remind` 作为纯提醒语义。
- 使用 `agent_chat` 表示周期性运行 agent prompt，并把最终回复推送到原渠道。
- 飞书最终投递和插件通知统一使用 interactive markdown card；若 card 发送失败，再降级为普通 text，避免消息丢失。
- 不在 Samata 平台代码中固化某个本地 agent 或某条本地任务的发送流程，也不通过调度器主动调用业务/插件工具。
- 对具体运行库中的播报任务，仅通过 `payload.prompt` 做自然语言引导：不要把 Markdown 正文作为 `.md` 附件发送；如需要图片，提示 agent 自然调用已可见的图片生成和发送工具。

## 改动

- `scheduled_tasks.task_type` 支持 `agent_chat`，并增加旧库 CHECK 约束迁移。
- `create_scheduled_task` 工具声明同步支持 `agent_chat`。
- `task-scheduler` 新增 `agent_chat` 执行分支，按任务保存的 agent、创建人和投递上下文运行 `runAgenticChat`，再推送最终回复。
- `deliverMessage` 的飞书路径改发 markdown card，插件 `sendNotification` 的飞书路径同步改造。
- 新增 `src/feishu/markdown-card.ts` 复用飞书 markdown card 内容结构。
- 撤销曾尝试加入的 `runAgenticChat.disabledTools` 和调度器工具禁用特例，保持 agent tools 能力由通用权限系统和 prompt 引导决定。
- 更新当前运行库中的一条 `agent_chat` 定时任务 prompt，加入不发送 Markdown 正文附件、自然调用图片生成与发送工具的引导；运行数据不纳入 git。

## 验证

- `npx tsc --noEmit`
- `npx vitest run tests/unit/tools/schedule.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts`
- `npx vitest run tests/unit/services/deliver.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts tests/unit/plugins/registry-delivery.test.ts`
- `npx vitest run tests/unit/schema/schema.test.ts`
- `git diff --check`
- 只读 SQL 确认运行库中的目标 `agent_chat` 任务 prompt 已包含图片生成与发送工具引导，且没有平台层工具禁用配置。
