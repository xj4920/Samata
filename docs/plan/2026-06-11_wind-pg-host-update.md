---
docModules:
  - external-data
docTopics:
  external-data: Wind PostgreSQL
canonicalDocs:
  - /external-data/wind-postgres
status: implemented
---

# Wind PG 连接地址更新

## 背景

企微侧执行 Wind 行情查询时，连接仍指向旧地址 `175.178.64.67:3395`，导致 PostgreSQL 连接失败。新的 Wind PostgreSQL 查询入口为 `10.8.0.1:3395`。

## 决策

- 仅更新正式 Wind PostgreSQL 查询文档 `docs/wind-database.md` 中的 host，端口仍保持 `3395`。
- 不修改 `docs/oracle-wind-database.md` 中的 `175.178.64.67:8848`，该地址描述的是 DolphinDB 同步目标，不属于本次 PostgreSQL 查询入口。
- 不修改 `.env.example` 中的 `127.0.0.1` / `wind_sync_pg` 示例，因为这些是本机或 Docker 网络部署默认值。

## 改动清单

- `docs/wind-database.md`
  - 将连接参数表的 Host 从 `175.178.64.67` 改为 `10.8.0.1`。
  - 将 Python `psycopg2.connect` 示例的 `host` 从 `175.178.64.67` 改为 `10.8.0.1`。
- `docs/plan/2026-06-11_wind-pg-host-update.md`
  - 记录本次背景、决策、改动、验证命令、提交与构建影响。

## 验证命令

已执行：

```text
npm run docs:plan-sync
git diff --check
rg -n "175\\.178\\.64\\.67|10\\.8\\.0\\.1|3395" docs/wind-database.md docs/oracle-wind-database.md
```

## 验证结果

- `npm run docs:plan-sync` 成功退出并更新 `docs/.vitepress/plan-index.generated.ts`；输出仍包含既有历史 plan 缺少或未配置 `docModules` 的 warning/error，本次新增 plan 未被点名。
- `git diff --check` 通过。
- `rg -n "175\\.178\\.64\\.67|10\\.8\\.0\\.1|3395" docs/wind-database.md docs/oracle-wind-database.md` 确认：
  - `docs/wind-database.md` 已指向 `10.8.0.1:3395`。
  - `docs/oracle-wind-database.md` 中保留的 `175.178.64.67:8848` 是 DolphinDB 同步目标，未误改。

## Commit Hash

- 实现提交：待提交后补充。
- 留档回填提交：待提交后补充。

## 构建与运行影响

- 仅文档与计划留档改动，不影响运行时构建产物、Docker image、插件构建产物、依赖或数据库迁移。
- 不需要重新构建 Docker image、重启服务或重新生成插件构建产物。
