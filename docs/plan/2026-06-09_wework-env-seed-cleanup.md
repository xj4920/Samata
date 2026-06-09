---
docModules:
  - platform
docTopics:
  platform: 部署与配置
status: implemented
canonicalDocs:
  - /platform/deployment
---

# 清理 WeWork 环境变量历史 Seed 逻辑

## 背景

Samata 的 WeWork bot 运行时配置已经迁移到 SQLite `bot_apps` 表，并通过 `/agent bot-app` 与 `/agent assign` 管理。`src/db/schema.ts` 中仍保留早期 `WEWORK_AIBOT_BOT_ID` / `WEWORK_AIBOT_SECRET` 一次性 seed 逻辑，会在 `migrate-feishu-apps-to-bot-apps` migration 首次执行时自动插入名为 `wework-bot` 的 WeWork bot。

该逻辑已经不再符合当前配置来源：SQLite `bot_apps` 应是 WeWork bot 配置的权威来源，环境变量不应再隐式写入运行时 bot 配置。

## 决策

- 删除 `migrate-feishu-apps-to-bot-apps` 内读取 `WEWORK_AIBOT_*` 并插入 `bot_apps` 的历史逻辑。
- 保留 migration id 与旧 `feishu_apps` 到 `bot_apps` 的迁移逻辑，避免影响已执行 migration 记录。
- 保留现有 SQLite 数据，不删除任何已有 `bot_apps` 记录。
- 更新 `src/wework-entry.ts` 启动说明，明确 WeWork bot 通过 DB 配置管理。
- 不在本次引入 Umzug、不处理 `seed-ticlaw-agent` / `wework-test-bot-setup` 等更大范围治理。

## 改动清单

- `src/db/schema.ts`
  - 移除 `WEWORK_AIBOT_BOT_ID` / `WEWORK_AIBOT_SECRET` 自动 seed `wework-bot` 的代码块。
- `src/wework-entry.ts`
  - 删除环境变量自动 seed 的过时说明。
  - 保留 `WEWORK_PORT` 健康检查端口说明。
- `tests/unit/schema/schema.test.ts`
  - 增加回归测试：即使进程环境中存在旧 `WEWORK_AIBOT_*`，`initSchema()` 也不会新增 `wework-bot`。
- `docs/plan/2026-06-09_wework-env-seed-cleanup.md`
  - 记录本次背景、决策、改动、验证、提交与构建影响。

## 验证命令

已执行：

```text
npm run docs:plan-sync
npm run test:unit -- tests/unit/schema/schema.test.ts
npm run test:unit -- tests/unit/schema
rg -n "WEWORK_AIBOT" src/db/schema.ts src/wework-entry.ts
git diff --check
```

## 验证结果

- `npm run docs:plan-sync` 通过并更新 `docs/.vitepress/plan-index.generated.ts`；命令输出中仍包含既有历史 plan 缺少 frontmatter 的提示，本次新增文件未被点名。
- `npm run test:unit -- tests/unit/schema/schema.test.ts` 通过：1 个测试文件，33 个测试。
- `npm run test:unit -- tests/unit/schema` 通过：2 个测试文件，36 个测试。
- `rg -n "WEWORK_AIBOT" src/db/schema.ts src/wework-entry.ts` 无匹配，确认目标运行入口不再引用旧环境变量。
- `git diff --check` 通过。

## Commit Hash

待用户确认提交后在最终回复记录。Git commit 无法在同一个提交内容中稳定记录自身最终 hash，因此本文件记录提交状态，最终 hash 以后续提交结果为准。

## 构建与运行影响

- 影响启动期运行时代码：部署到运行环境后需要重新构建或发布对应 runtime / Docker image，并重启 Samata 后生效。
- 不新增依赖。
- 不新增数据库 migration。
- 不修改当前 `data/samata.db`，现有 WeWork bot 仍由 SQLite `bot_apps.auto_start` 控制。
