-- 在 wind_sync 上执行：确认 Wind 复合索引是否已创建（名称与 wind_sync_indexes.sql 一致）。
-- 若缺少某行，请执行 scripts/wind_sync_indexes.sql 中对应 CREATE INDEX CONCURRENTLY。

SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_ashareeodprices_wind_trade_dt',
    'idx_ashareeodderivative_wind_trade_dt',
    'idx_ashareincome_wind_stmt_period',
    'idx_asharebalancesheet_wind_stmt_period',
    'idx_ashareconsensus_wind_est_dt'
  )
ORDER BY tablename, indexname;
