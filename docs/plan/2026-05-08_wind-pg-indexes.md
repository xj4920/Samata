# Wind PG 索引落地（2026-05-08）

## 执行结果

- 在 `wind_sync` 上对日志中 6 条典型 SQL 做了 `EXPLAIN (ANALYZE, BUFFERS)`：建索引前 `ASHAREEODPRICES` / `ASHAREINCOME` / `ASHAREBALANCESHEET` 等对 LLM 查询走并行 Seq Scan；`ASHAREEODDERIVATIVEINDICATOR` / `ASHARECONSENSUSDATA` 仅按日期索引扫描再过滤 windcode。
- 已执行 `CREATE INDEX CONCURRENTLY IF NOT EXISTS` 五条（见 `[scripts/wind_sync_indexes.sql](../../scripts/wind_sync_indexes.sql)`），并对五表 `ANALYZE`。
- 复核：`ASHAREEODPRICES` 近一年区间查询由约 1.26s 降至约 26ms；资产负债表最新一期由约 1.42s 降至约 4ms（示例 windcode `000776.SZ`）。

## 同业 PE / 行业 JOIN

- 当前库内无「证券–CSRC 行业」映射表（仅有 `ASHAREINDUSTRIESCODE` 字典）。同业筛选需在 dataSync 同步对应表后再建索引；说明已写入 `[docs/wind-database.md](../../docs/wind-database.md)`「常见陷阱」第 11 条与「PostgreSQL 索引」节。

## LLM 按索引查询（文档与 Agent）

- `[docs/wind-database.md](../../docs/wind-database.md)` 已扩展「PostgreSQL 索引与查询形状」：每条复合索引对应的 `WHERE`/`ORDER BY`、反模式、`EXPLAIN` 示例。
- `[config/agents/otcclaw.md](../../config/agents/otcclaw.md)` 增加步骤第 8 条索引命中硬约束。
- 运维校验索引是否存在：`[scripts/wind_sync_verify_indexes.sql](../../scripts/wind_sync_verify_indexes.sql)`。