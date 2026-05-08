-- wind_sync（PostgreSQL）复合索引：对齐 LLM / sandbox 典型查询（按 S_INFO_WINDCODE + 日期或报告期）。
-- 使用 CONCURRENTLY 以避免长时间阻塞写入；需在会话外单独执行每条（已带 IF NOT EXISTS）。
-- 执行前请确认连接为 wind_sync 库；执行后建议：ANALYZE 各表。

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ashareeodprices_wind_trade_dt
  ON public."ASHAREEODPRICES" ("S_INFO_WINDCODE", "TRADE_DT");

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ashareeodderivative_wind_trade_dt
  ON public."ASHAREEODDERIVATIVEINDICATOR" ("S_INFO_WINDCODE", "TRADE_DT");

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ashareincome_wind_stmt_period
  ON public."ASHAREINCOME" ("S_INFO_WINDCODE", "STATEMENT_TYPE", "REPORT_PERIOD" DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_asharebalancesheet_wind_stmt_period
  ON public."ASHAREBALANCESHEET" ("S_INFO_WINDCODE", "STATEMENT_TYPE", "REPORT_PERIOD" DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ashareconsensus_wind_est_dt
  ON public."ASHARECONSENSUSDATA" ("S_INFO_WINDCODE", "EST_DT" DESC NULLS LAST);
