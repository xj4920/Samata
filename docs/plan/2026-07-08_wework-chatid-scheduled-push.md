---
docModules:
  - platform
docTopics:
  platform: 企微集成与定时任务
canonicalDocs:
  - /platform/deployment
status: implemented
---

# 企微 chatid 上下文与 08:30 定时推送修复

## 背景

2026-07-08 08:30 的 `otcclaw` 公司行为提醒定时任务已执行并生成正文，但没有推送到“公司行为通知”群。排查发现企微入口底层 `frame.body.chatid` 已存在，日志中也能看到群聊 `chatid`，但 `DeliveryContext` 没有把企微 `chatid` / bot app id 传给 agent 和 `create_scheduled_task` 工具，导致任务落库时 `target_id` 与 `app_id` 为空。运行时投递逻辑在 `wework` 且缺少 `target_id` 时只打印日志，不会主动推送到群。

## 决策

1. 企微消息进入 agent 时，将当前群聊或单聊目标写入 `DeliveryContext.targetId`，并写入 `appId`、`weworkChatId`、`weworkChatType`、`weworkUserId`、`weworkBotName`。
2. agent system prompt 追加运行时上下文，让模型可直接回答当前企微群 `chatid`，也能在创建定时任务时默认使用当前投递目标。
3. `list_scheduled_tasks` 返回 `target_id` 与 `app_id`，方便后续排查任务是否绑定到真实投递目标。
4. 现有生产任务采用运行库热修复：只更新 `608f4592-c97f-4fdc-89a4-941bfd69acdc` 的目标群与 bot app，不改其它任务。

## 改动清单

- `src/llm/agents/config.ts`
  - 扩展 `DeliveryContext`，加入企微会话元数据字段。
- `src/wework/bot.ts`
  - 构建 `deliveryContext` 时补充 `targetId`、`appId` 和企微 `chatid/chattype/userid/botName`。
- `src/llm/agent.ts`
  - 新增 `buildDeliveryContextSystemPrompt()`，将当前通道和企微 `chatid` 注入本轮 system prompt。
- `src/services/task-scheduler.ts`
  - 定时任务执行时，如目标为企微群 `chatid`，同步注入 `weworkChatId/weworkChatType`。
- `src/tools/schedule-tools.ts`
  - `list_scheduled_tasks` 输出 `target_id` 与 `app_id`。
- `tests/unit/tools/schedule.test.ts`
  - 增加 WeWork 群聊定时任务落库 `target_id/app_id` 覆盖。
- `tests/unit/llm/delivery-context.test.ts`
  - 覆盖 agent 可见的企微 `chatid` 运行时上下文。
- `package.json` / `package-lock.json`
  - 版本从 `3.0.25` 递增到 `3.0.26`。

## 运行库修复

已先备份运行库：

```text
/opt/samata/data/backups/samata-before-wework-chatid-20260708092607.db
```

已更新生产运行库 `/opt/samata/data/samata.db`：

```text
task_id: 608f4592-c97f-4fdc-89a4-941bfd69acdc
name: 每日公司行为提醒同步与推送
target_id: wrfvtgBgAAjdsXmbge5nt_WrtDP_4Zfw
app_id: aibsBv1aVuu8jyVwy3nWvFovDz1rltvleDO
next_run_at: 2026-07-09 08:30:00 Asia/Shanghai
```

## 验证命令

已执行：

```bash
npm run test:unit -- tests/unit/llm/delivery-context.test.ts tests/unit/tools/schedule.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts
npm run docs:plan-sync
node --input-type=module <read scheduled task verification>
```

结果：

- 单测通过：3 个测试文件，25 个用例通过。
- `docs:plan-sync` 已更新 `docs/.vitepress/plan-index.generated.ts`；历史 plan 仍有既有 frontmatter 警告/错误，本次新增 plan 已包含 `docModules`。
- 只读查询确认 `608f4592-c97f-4fdc-89a4-941bfd69acdc` 已绑定 `target_id=wrfvtgBgAAjdsXmbge5nt_WrtDP_4Zfw`、`app_id=aibsBv1aVuu8jyVwy3nWvFovDz1rltvleDO`，下次运行时间为 `2026-07-09 08:30:00`。

## Commit

- implementation commit hash：`0f4ed29`

## 构建与重启影响

本次改动影响运行时代码与版本号。生产库中现有 08:30 任务目标群已经热修复；但“后续给 agent 传递 chatid 信息”的代码需要重新构建并重启 OtcClaw 容器后在线上生效。由于 `package.json` 版本递增，发布 OtcClaw 镜像时需要重新构建对应 image。
