---
name: 交易数据查询与导出
description: OTC 交易数据查询、汇总、绘图与 CSV 导出的使用指南
---

## 工具选择指南

| 用户意图 | 工具 |
|---|---|
| 查某客户/某日的交易明细（少量数据分析） | `query_trades` |
| 按管理人维度看日报、汇总表格 | `trade_summary` |
| 画交易趋势图 | `plot_trades` |
| 导出 CSV / 全量数据 / 下载 | `export_trades_csv` |
| 导出北向极速数据 | `export_north_info_csv` |
| 查看管理人与交易对手的映射关系 | `list_customers` |

重要：用户要求导出、下载、全量数据时，必须用 `export_trades_csv` 或 `export_north_info_csv`，不要用 `query_trades` 逐批拉取。

## 核心概念

- **管理人（client）与交易对手（party）为 1:N 映射**：指定 client 会自动展开为其下所有交易对手
- **日期格式**：统一 YYYYMMDD
- **date vs date_from/date_to**：date 精确匹配单日；date_from/date_to 做范围查询。查某月数据时用范围，不要逐日调用

## 返回字段说明

### query_trades 字段

- `notional_t` = T日存续名义本金
- `trade_amt_ft` = T日成交金额
- `ft_net` = 净交易头寸（非盈亏）

### trade_summary 字段

summaries 数组每条：
- `manager` = 管理人
- `pos_num` = 持仓数，`trade_num` = 交易笔数
- `notional_t` = T日多头存续名义本金，`notional_short_t` = T日空头存续名义本金
- `trade_amt_ft` = T日多头成交金额，`trade_amt_ft_short` = T日空头成交金额
- `ft_net` = T日多头净买入，`ft_net_short` = T日空头净买入

顶层总计：`totalNotional` / `totalNotionalShort` / `totalTradeAmt` / `totalTradeAmtShort`

### export_north_info_csv 固定 10 列

trade_dt, counter_party_short_name, notional_ft_t, notional_ft_short_t, trade_amt_ft, trade_amt_ft_short, ft_net, ft_net_short, is_ft, update_time

其中 `notional_ft_t = notional_ft_t_1 + ft_net`，`ft_net_short` 已取负。

## 渲染规范（trade_summary 表格）

- 所有金额字段单位为元，渲染时一律换算成「亿」并保留 3 位小数（如 61.900亿、+0.080亿）
- 净买入字段保留正负号
- 字段名带 `_t` 已经是 T 日值，不要标成 "T-1"
- 多空两个维度可合并展示（如 名义金额(多/空) = 61.900亿 / 3.200亿）
- 直接使用上述中文作为列标题，不要自行推断或翻译字段名
