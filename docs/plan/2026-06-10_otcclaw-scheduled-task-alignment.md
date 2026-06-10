---
docModules:
  - platform
docTopics:
  platform: 调度与任务
canonicalDocs:
  - /platform/common-tools
status: implemented
---

# otcclaw/ticlaw 定时任务对齐与执行通知

## 背景

用户复核 `otcclaw` / `ticlaw` 当前定时任务后提出调整：

- `fast-trading-summary-sync-otcclaw` 不应每日执行，应与交易相关任务一致改为周一到周五执行。
- `283ce632-45ab-468a-823b-90244bb12cad` 是历史 UUID 任务 ID，与当前语义化任务 ID 风格不一致。
- `etf-ticlaw-precalc` 与 `etf-otcclaw-precalc` 同时在 18:00 执行，应错峰到 18:15。
- 所有 Samata 内部定时任务执行完毕后，应向许骏企微发送统一状态通知。

当前 main 已完成 schema 清理，`src/db/schema.ts` 不再 seed 业务 agent 和业务定时任务；运行库中现有 `otcclaw` 定时任务继续作为生产运行数据维护。

## 决策

- 将 FastTrading summary 同步任务 cron 从 `30 18 * * *` 改为 `30 18 * * 1-5`。
- 将常速业务规模同步任务 ID 从 `283ce632-45ab-468a-823b-90244bb12cad` 改为 `normal-trading-summary-sync-otcclaw`。
- 将 TIClaw ETF 预计算任务 cron 从 `0 18 * * 1-5` 改为 `15 18 * * 1-5`。
- 调度器在每个已 claim 的任务执行结束后发送状态通知；未到期、被锁跳过、查询失败不通知。
- 通知目标使用企微 userid `gzxujun`，默认通道为 `wework:wework-bot`，可用环境变量覆盖：
  - `SCHEDULED_TASK_NOTIFY_CHANNEL`
  - `SCHEDULED_TASK_NOTIFY_TARGET_ID`
- 不把 `otcclaw` 业务定时任务重新写回 `src/db/schema.ts`，保持平台 schema 与业务插件任务解耦。
- 不新增迁移、不修改插件构建产物。

## 改动清单

- `data/samata.db`（被 `.gitignore` 忽略，不纳入提交）
  - 更新 `fast-trading-summary-sync-otcclaw` 的 `cron_expr` 为 `30 18 * * 1-5`，重新计算 `next_run_at`，清空 `locked_until`。
  - 更新 `283ce632-45ab-468a-823b-90244bb12cad` 的任务 ID 为 `normal-trading-summary-sync-otcclaw`，保留任务名称、payload、channel、created_by 和历史执行结果。
  - 更新 `etf-ticlaw-precalc` 的 `cron_expr` 为 `15 18 * * 1-5`，重新计算 `next_run_at`，清空 `locked_until`。
- `src/services/task-scheduler.ts`
  - 新增任务完成/失败状态通知，格式为 `HH：MM：SS ： [ID], 名称, 执行完成/失败， null/失败原因`。
  - 通知发送失败只记录日志，不覆盖任务执行结果。
- `src/services/deliver.ts`
  - 支持 `wework:<bot-id-or-name>` 通道，按指定企微 bot 主动推送。
- `tests/unit/services/task-scheduler-agent-chat.test.ts`
  - 覆盖定时任务成功和失败后的状态通知。
- `tests/unit/services/deliver.test.ts`
  - 覆盖 `wework:wework-bot` 指定 bot 投递。
- `docs/plan/2026-06-10_otcclaw-scheduled-task-alignment.md`
  - 记录本次运行库调整、决策、验证命令、提交状态和构建影响。

## 验证命令

已执行：

```text
npm run docs:plan-sync
npm run test:unit -- tests/unit/services/task-scheduler-agent-chat.test.ts tests/unit/tools/schedule.test.ts tests/unit/services/deliver.test.ts tests/unit/schema/schema.test.ts
npx tsc --noEmit
git diff --check
node --input-type=module - <<'NODE'
// 只读查询 data/samata.db 中 otcclaw/ticlaw scheduled_tasks
NODE
```

## 验证结果

- `npm run docs:plan-sync` 通过并更新 plan index；输出中仍有既有历史 plan 缺少 frontmatter 的提示，本次文件未被点名。
- `npm run test:unit -- tests/unit/services/task-scheduler-agent-chat.test.ts tests/unit/tools/schedule.test.ts tests/unit/services/deliver.test.ts tests/unit/schema/schema.test.ts` 通过：4 个测试文件，60 个测试。
- `npx tsc --noEmit` 通过。
- `git diff --check` 通过。
- 只读查询确认 `etf-ticlaw-precalc` 已改为 `15 18 * * 1-5`，`fast-trading-summary-sync-otcclaw` 保持 `30 18 * * 1-5`，`normal-trading-summary-sync-otcclaw` 保持 `0 19 * * 1-5`。

## Commit Hash

- 待提交后回填。

## 构建与运行影响

- 影响 Samata runtime 代码（调度器与投递服务），需要重启 Samata 服务后生效。
- 若生产以 Docker image 部署，需要重建/发布 Samata image 后再重启容器。
- 不影响插件构建产物、依赖或数据库迁移。
- 已尝试 `bash scripts/docker-samata.sh build`，但 Docker daemon 配置的 `127.0.0.1:7890` 代理不可用，拉取 `node:22-bookworm-slim` 元数据失败；`docker pull node:22-bookworm-slim` 同样失败。
- 当前 image 未重建，容器未重启；需修复 Docker daemon 代理后重新构建并重启。
