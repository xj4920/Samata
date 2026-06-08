# otcclaw 19:00 定时任务改为常速规模同步

## 概要

将 `otcclaw` 现有 19:00 工作日定时任务从北向极速 summary 同步改为 NormalTrading 常速成交与业务规模同步。

## 背景

当前 `scheduled_tasks` 中 ID 为 `283ce632-45ab-468a-823b-90244bb12cad` 的任务名称为“北向极速日终数据同步”，cron 为 `0 19 * * 1-5`，payload 调用 `sync_fast_trading_summary`。用户要求该 19:00 任务改为常速规模同步。

## 决策

- 保留任务 ID：`283ce632-45ab-468a-823b-90244bb12cad`。
- 保留 cron：`0 19 * * 1-5`。
- 保留 channel：`wework`。
- 将任务名称改为“北向常速业务规模同步”。
- 将 payload 改为 `{"tool_name":"sync_normal_trading_summary","input":{},"notify":false}`。
- 清空旧的 `last_run_at` 和 `last_result`，避免继续展示 FastTrading 旧执行结果。

## 改动清单

- `src/commands/scheduled-task.ts`
  - `tool_call` allowlist 增加 `sync_normal_trading_summary`。
  - 常速同步工具复用 FastTrading 同步工具的 `date_from`、`date_to`、`force`、`keep_raw` 输入校验。
- `src/db/schema.ts`
  - 新增幂等 migration，维护 19:00 `otcclaw` 定时任务为常速同步。
  - admin/全量 agent 的业务工具 blocklist 增加 `sync_normal_trading_summary`。
- `tests/helpers/unit-harness.ts`
  - mock 插件执行支持 `sync_normal_trading_summary`，并模拟管理员授权校验。
- `tests/unit/schema/schema.test.ts`
  - 覆盖 19:00 常速同步任务种子记录。
- `tests/unit/tools/schedule.test.ts`
  - 覆盖常速同步 tool_call 可创建、可由后台定时授权执行。
- `data/samata.db`
  - 直接更新当前运行库中的 19:00 任务记录；该文件被 `.gitignore` 忽略，不纳入提交。

## 测试计划

- 运行 `npx vitest run tests/unit/schema/schema.test.ts tests/unit/tools/schedule.test.ts`。
- 运行 `git diff --check`。
- 查询 `data/samata.db` 确认 19:00 任务已改为 `sync_normal_trading_summary`。
- 检查 `git status --short --branch`，确认只提交本次相关代码和 plan。

## 验证结果

已通过：

```text
npx vitest run tests/unit/schema/schema.test.ts tests/unit/tools/schedule.test.ts
git diff --check
```

当前 `data/samata.db` 已确认：

```text
id: 283ce632-45ab-468a-823b-90244bb12cad
name: 北向常速业务规模同步
cron_expr: 0 19 * * 1-5
payload: {"tool_name":"sync_normal_trading_summary","input":{},"notify":false}
channel: wework
next_run_at: 2026-06-09 19:00:00
last_run_at: null
last_result: null
```

## 提交记录

```text
将 otcclaw 19 点任务改为常速同步
```
