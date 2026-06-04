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

# 定时任务设置权限与授权运行

## 背景

用户确认北向极速 summary 定时同步的期望权限模型：

- `sync_fast_trading_summary` 是实际插件工具，用于从 SFTP 同步 FastTrading summary CSV 并写入 PostgreSQL。
- `fast-trading-summary-sync-otcclaw` 是 Samata 内置种子定时任务 ID，payload 调用同一个 `sync_fast_trading_summary` 工具。
- 用户手动创建的 `283ce632...` 任务同样调用 `sync_fast_trading_summary`，只是 cron 时间为工作日 19:00。
- 定时任务的创建、更新、删除需要 agent admin 权限；后续后台定时运行时，应视为创建/更新时已经授权，不再重复卡插件内的交互式 admin 检查。

## 决策

1. 保留后台调度的 `channel: system`，不伪装成 CLI，避免混淆日志和审计语义。
2. 在执行上下文中增加 `scheduledTaskAuthorized` 标记，只由 task scheduler 在执行已登记的 `tool_call` 定时任务时设置。
3. 插件上下文的 `ctx.isAdmin()` 在该标记存在时返回 `true`，表示此调用经过定时任务授权链路。
4. `create_scheduled_task`、`update_scheduled_task`、`delete_scheduled_task` 工具入口统一要求当前用户是当前 agent 的 admin；列表查询保持不变。
5. 单测 mock 模拟真实插件的 admin gate，避免再次漏掉 `sync_fast_trading_summary` 这类后台运行权限问题。

## 改动清单

- `src/runtime/execution-context.ts`
  - 新增 `scheduledTaskAuthorized` 执行上下文字段。
  - 新增 `isScheduledTaskAuthorized()` helper。
- `src/services/task-scheduler.ts`
  - 后台执行 `tool_call` 定时任务时带上 `scheduledTaskAuthorized: true`。
- `src/plugins/registry.ts`
  - 插件 `ctx.isAdmin()` 在定时任务授权执行上下文中返回 `true`。
- `src/tools/schedule-tools.ts`
  - 创建、更新、删除 Samata 内部定时任务前检查 agent admin。
  - 复用 agent admin 校验 helper，并保留 crontab 管理原有权限要求。
- `tests/helpers/unit-harness.ts`
  - mock logger，避免单测写入真实 `logs/app-YYYY-MM-DD.log`。
  - mock 插件工具对 `sync_fast_trading_summary` 执行 admin gate。
- `tests/unit/tools/schedule.test.ts`
  - 覆盖后台定时运行时 `isAdmin=true`。
  - 覆盖非 agent admin 不能创建、更新、删除定时任务，授予 agent admin 后可以操作。

## 验证命令

```bash
npm test -- tests/unit/tools/schedule.test.ts
npm test -- tests/unit/config/rbac.test.ts tests/unit/config/agent-config.test.ts
npm test -- tests/unit/tools/schedule.test.ts tests/unit/config/rbac.test.ts tests/unit/config/agent-config.test.ts
npx tsc --noEmit
npm run docs:plan-sync
```

结果：

- `tests/unit/tools/schedule.test.ts`：18 tests passed。
- `tests/unit/config/rbac.test.ts tests/unit/config/agent-config.test.ts`：28 tests passed。
- 合并相关测试：3 files passed，46 tests passed。
- TypeScript 检查：通过。
- `docs:plan-sync`：退出码 0；新留档已进入索引。输出中仍有若干历史 plan 缺 `docModules` 的既有提示，本次未改动。

## Commit Hash

实现提交：`4930b36`。
