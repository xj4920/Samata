---
docModules:
  - platform
docTopics:
  platform: 调度与任务
canonicalDocs:
  - /platform/common-tools
status: implemented
---

# Scheduled Task agent_chat CHECK 迁移

## 背景

2026-06-29 在企微群中通过 Otcclaw 创建“每日公司行为提醒”定时任务时，`create_scheduled_task` 调用已到达后端，但写入 `scheduled_tasks` 失败：

```text
CHECK constraint failed: task_type IN ('remind', 'sandbox_exec', 'tool_call')
```

源码中的 `ScheduledTaskType`、工具声明和调度器已经支持 `agent_chat`，但生产运行库 `/opt/samata/data/samata.db` 的旧表 CHECK 约束仍只允许 `remind`、`sandbox_exec`、`tool_call`。SQLite 不会因为 `CREATE TABLE IF NOT EXISTS` 自动更新既有表约束，因此需要显式迁移。

## 决策

- 只修复 SQLite 旧库 `scheduled_tasks.task_type` CHECK 约束，使其支持 `agent_chat`。
- 保留前端/聊天入口创建、更新、删除定时任务的现有流程，不把 Otcclaw 公司行为任务硬编码写入 schema、seed 或 migration。
- 不在本次加入 agent_chat 静默投递语义；“无公司行为是否输出”继续由前端创建任务时的 prompt/后续任务修改决定。
- migration 使用表重建方式扩展 CHECK 约束，并保留现有任务数据与 `locked_until` 等运行字段。

## 改动清单

- `src/db/migrations/2026_06_29_scheduled_tasks_agent_chat_check.ts`
  - 新增 Umzug migration。
  - 检测旧表 SQL 中是否缺少 `'agent_chat'`，缺少时重建 `scheduled_tasks` 并迁移已有数据。
  - 对已经包含 `agent_chat` 的新库保持 no-op。
- `tests/unit/schema/migrations.test.ts`
  - 新增旧表约束迁移测试，验证迁移后可插入 `agent_chat` 任务，并保留旧任务数据。
- `docs/plan/2026-06-29_scheduled-task-agent-chat-check-migration.md`
  - 记录本次背景、决策、改动、验证与发布影响。

## 验证命令

已执行：

```text
npm run test:unit -- tests/unit/schema/migrations.test.ts tests/unit/tools/schedule.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts
npm run test:unit -- tests/unit/schema/schema.test.ts
npx tsc --noEmit
npm run docs:plan-sync
git diff --check
```

已执行运行库副本验证：

```text
node --import tsx/esm --input-type=module - <<'NODE'
// 使用 SQLite backup API 复制 /opt/samata/data/samata.db 到 /tmp，
// 在副本上执行 runMigrations，并插入 agent_chat smoke 任务。
NODE
```

## 验证结果

- `npm run test:unit -- tests/unit/schema/migrations.test.ts tests/unit/tools/schedule.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts` 通过：3 个测试文件，27 个测试。
- `npm run test:unit -- tests/unit/schema/schema.test.ts` 通过：1 个测试文件，36 个测试。
- `npm run docs:plan-sync` 通过并更新 `docs/.vitepress/plan-index.generated.ts`；输出仍包含既有历史 plan frontmatter warning/error，本次新增 plan 未被点名。
- `git diff --check` 通过。
- `npx tsc --noEmit` 未通过，阻塞点为既有 `src/services/mcp-manager.ts` 中 `ParsedLogyiDate | null` 赋值给 `ParsedLogyiDate | undefined` 的类型错误；本次 migration 与测试文件未产生新的 tsc 错误。
- 运行库副本验证通过：`before_has_agent_chat=false`，`after_has_agent_chat=true`，并成功插入一条 `agent_chat` smoke 任务；临时副本已删除。

## Commit Hash

- 待提交。

## 构建与运行影响

- 影响 Samata runtime 的数据库迁移文件；生产容器需加载新代码并重启后才会自动修复 `/opt/samata/data/samata.db`。
- 不影响插件构建产物、依赖和业务运行库任务 seed。
- 本次不直接创建或修改 Otcclaw 公司行为定时任务；迁移生效后仍通过前端/聊天的 `create_scheduled_task` 或 `update_scheduled_task` 管理。
- 生产运行库尚未原地迁移，Samata image 尚未重建，容器尚未重启。
