# TiClaw 沙箱 + Wind 数据库能力（2026-05-08）

## 背景

TiClaw（`agents.name = ticlaw`）在 `tools_list` 中已包含 sandbox 与 `read_file`，但缺少 `config/agents/ticlaw.files.json`，沙箱内 `.data/` 无法挂载 Wind 文档；全局成员 `user_tools_list` blocklist 仍包含 `read_file`，企微普通成员无法走白名单读取。

## 实现摘要

1. **`config/agents/ticlaw.files.json`** — 与 otcclaw 对齐：`docs/wind-database.md`、`docs/wind-tables-schema.md`、`docs/wind-tables/`、`docs/influxdb-guide.md`。驱动 `authorizeRead`（`src/tools/file-tools.ts`）与 `loadSandboxAllowlist`（`src/commands/sandbox.ts`）（沙箱只读挂载）。
2. **Migration `ticlaw-add-read-file-wind`** — [`src/db/schema.ts`](../../src/db/schema.ts)：从 ticlaw 的 `user_tools_list` 移除 `read_file`；防御性补齐 `sandbox_*` 与 `read_file` 到 `tools_list`。
3. **`config/agents/ticlaw.md`** — 核心能力增加一条 Wind 公开市场数据路由（先读文档再沙箱查询，索引顺序见 `docs/wind-database.md`）。

## 验收

```sql
SELECT tools_list, user_tools_list FROM agents WHERE name = 'ticlaw';
```

- `user_tools_list` 中不应再包含 `read_file`（或为 NULL）。
- 非 admin 成员：`read_file docs/wind-database.md` 成功。
- `sandbox_exec`（Python）可访问 `.data/docs/wind-database.md`，且宿主可达 `wind_sync` PostgreSQL 时查询成功。

## 可选后续

若 Wind PG 非本机 `127.0.0.1`，可考虑在 bwrap 中注入 `PG_WIND_*` 环境变量（见 `.env.example`），与文档联动说明。
