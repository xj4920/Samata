---
docModules:
  - external-data
docTopics:
  external-data: 报价与交易
canonicalDocs:
  - /external-data/pricing-and-trade
status: implemented
---

# North Info CSV 导出工具

> 2026-04-27 落地。配套 cursor plan 文件：`.cursor/plans/north-info_export_csv_fd48f65e.plan.md`。

## 背景

衍语日常对外汇报需要按交易对手维度提供 north_info 表的多空头快照（多/空 名本(T)、成交金额、建仓、是否极速、更新时间）。现有 `export_trades_csv` 是按管理人/交易对手细粒度导出业务字段，列结构与"按交易对手做最新快照"的口径不匹配。

## 关键决策

- **沿用 InfluxDB 原始字段，不改 schema**：`TradeRecord` 已包含 `trade_dt / counter_party / notional_ft_t_1 / notional_ft_short_t / trade_amt_ft / trade_amt_ft_short / ft_net / ft_net_short / is_ft / update_time`，新工具直接在 [src/commands/trade.ts](src/commands/trade.ts) 做映射。
- **多头名本(T) 沿用现有口径**：`notional_ft_t_1 + ft_net`，与 [src/commands/trade.ts](src/commands/trade.ts) 中 `fetchTrades` / `fetchTradeSummary` 的算法一致；空头名本(T) 直接读 `notional_ft_short_t`（DB 已是 T 日值）。
- **空头建仓取负**：`ft_net_short` 在 DB 里语义是"净买入"，业务侧"空头建仓"通常用反号表示，CSV 输出 `-(r.ft_net_short ?? 0)`。
- **`is_ft` 归一化为 Y/N**：DB 是 string，按 `'1' | 'Y' | 'true' | 't'` → `'Y'`，否则 `'N'`，避免下游不一致。
- **CSV 列序锁定 10 列**：第一列固定 `trade_dt`（用户特别强调历史数据导出必须有日期，否则不合理），不开放 `columns` 参数自定义，规避列序漂移。
- **排序在数据层完成**：`fetchNorthInfo` 内部 `trade_dt ASC` 主排序、`counter_party_short_name ASC` 二级排序，handler 直接按数组顺序写盘。
- **默认查询最新一天**：不传 `date_from`/`date_to` 时，按 `time DESC` 拉 1000 条，按 counter_party 去重保留最新一条；传范围时直接落 `date_from / date_to` 给 `queryTrades`，limit 抬到 5000。

## 改动清单

### 1. [src/commands/trade.ts](src/commands/trade.ts)

新增：

```typescript
export interface NorthInfoRow {
  trade_dt: string;
  counter_party_short_name: string;
  notional_ft_t: number;
  notional_ft_short_t: number;
  trade_amt_ft: number;
  trade_amt_ft_short: number;
  ft_net: number;
  ft_net_short: number; // 已取负
  is_ft: 'Y' | 'N' | '';
  update_time: string;
}

export async function fetchNorthInfo(params: {
  date_from?: string;
  date_to?: string;
  limit?: number;
}): Promise<{ rows: NorthInfoRow[]; tradeDate: string }>;
```

辅助 `normalizeIsFt(raw)` 把 InfluxDB 的字符串 is_ft 映射成 Y/N/空串。

### 2. [src/tools/trade-tools.ts](src/tools/trade-tools.ts)

- `toolDefinitions` 追加 `export_north_info_csv`，description 列出 10 列字段、强调"空头建仓 = -ft_net_short"、说明排序规则。
- 新增 `NORTH_INFO_COLUMNS` 常量锁定列序。
- 新增 `handleExportNorthInfoCsv(input)`：调 `fetchNorthInfo`，按列序写 CSV 到 `os.tmpdir()/samata/north_info_<date>.csv`。
- `handleTool` switch 新增 `case 'export_north_info_csv'`。

### 3. [src/db/schema.ts](src/db/schema.ts)

末尾追加 `runOnce('otcclaw-add-export-north-info-csv', ...)`，把工具名 push 进 otcclaw 的 `tools_list`。只读导出工具，不进 user blocklist（与 `export_trades_csv` 一致）。

## 不动的地方

- `TradeRecord` 不扩字段。
- `fetchTrades / fetchTradeSummary / fetchLatestTradeData` 现有口径不变。
- 不加 CLI 子命令、不加飞书/wework 卡片渲染。
- 不加 system prompt / file-hint 引导（工具 description 自描述足够）。

## 验证

1. `npm run build` 通过
2. 重启或 `/reload_app` 后：
   ```sql
   SELECT tools_list FROM agents WHERE name='otcclaw';
   ```
   应包含 `export_north_info_csv`
3. CLI 对话："导出最新 north_info" → 工具返回 `{ path, rows: ~25, columns, tradeDate }`，打开 CSV 验证 10 列、列序、空头建仓符号反转，行按 counter_party 字母序
4. CLI 对话："导出 4/20-4/24 的 north_info" → 工具传 date_from/date_to，输出多日数据，行按 `trade_dt` 升序、同日内按 `counter_party_short_name` 字母序
5. 抽查无空头管理人（如 EXPEDITION）：`ft_net_short` 列输出 `0`；JINLUO 行 `is_ft=N`
