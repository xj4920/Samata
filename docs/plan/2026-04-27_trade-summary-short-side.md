---
docModules:
  - external-data
docTopics:
  external-data: 报价与交易
canonicalDocs:
  - /external-data/pricing-and-trade
status: implemented
---

# Trade Summary 增加极速空头汇总

> 2026-04-27 落地。配套 cursor plan 文件：`.cursor/plans/trade-summary-add-short-side_988af1cc.plan.md`。

## 背景

旧版 `trade_summary` 只暴露多头维度（`notional_t / trade_amt_ft / ft_net`），InfluxDB `north_info` 表里其实另有一套极速空头字段（`notional_ft_short_t / trade_amt_ft_short / ft_net_short`）一直被 TS 层丢弃。同时上一次发现：tool 返回的是裸 JSON，LLM 渲染时会瞎猜列名（把 `notional_t` 错标成 "T-1 存续名义本金"）。

本次同时解决两件事：

1. 把空头三项接进 `trade_summary` 返回值与 CLI 命令模式表格
2. 在 tool description 里写清楚 key→中文标签 + 单位约定，根治 LLM 列名/单位幻觉

## 关键决策

- **`notional_ft_short_t` 直接是 T 日存续值**（命名一致，**不需要** + `ft_net_short`），与多头的 `notional_t = notional_ft_t_1 + ft_net` 算法不同——多头是因为数据库里只存 T-1 存续才需要二次相加，空头数据库里直接落了 T 日值
- **CLI 表格列数保持 6 列**：每个数值列内部用 `多/空` 合并字符串显示，避免 9 列把终端撑爆
- **Summary 数值统一格式化为「亿 + 3 位小数」**：新增 `formatBillion` / `formatBillionNet`，不动现有 `formatAmount`（明细查询、客户列表仍按阈值在亿/万切换）
- **`notional_t` 现有口径不变**：避免向后兼容问题，空头作为独立维度并列

## 改动清单

### 1. `src/db/influxdb.ts`

`TradeRecord` 新增 3 字段：

```typescript
notional_ft_short_t: number | null;
trade_amt_ft_short: number | null;
ft_net_short: number | null;
```

### 2. `src/commands/trade.ts`

`ManagerTradeSummary` 接口扩展为 long/short 并列：

```typescript
export interface ManagerTradeSummary {
  manager: string;
  pos_num: number;
  trade_num: number;
  notional_t: number;          // 多头 T 日存续 = notional_ft_t_1 + ft_net
  notional_short_t: number;    // 空头 T 日存续 = notional_ft_short_t（直接取）
  trade_amt_ft: number;
  trade_amt_ft_short: number;
  ft_net: number;
  ft_net_short: number;
}
```

`fetchTradeSummary` 累加循环里追加空头三项，返回值同时新增 `totalNotionalShort` / `totalTradeAmtShort`。

新增格式化函数（仅 summary 路径使用）：

```typescript
function formatBillion(val: number): string {
  return `${(val / 1e8).toFixed(3)}亿`;
}

function formatBillionNet(val: number): string {
  const prefix = val > 0 ? '+' : '';
  return prefix + formatBillion(val);
}
```

CLI summary 表头/行/总计区域全部切到这两个新函数：

- 表头：`['管理人', 'POS#', 'TRADE#', '名义金额(多/空)', '成交金额(多/空)', '净买入(多/空)']`
- 数值列：``${formatBillion(s.notional_t)} / ${formatBillion(s.notional_short_t)}``
- 总计：`存续名义本金（多/空）：61.900亿 / 3.200亿`

### 3. `src/tools/trade-tools.ts`

`trade_summary` 的 description 改写为显式 key→label 映射：

- 列出 9 个字段的中文含义
- 声明顶层 totals 字段
- 单位约定：金额一律「亿」+ 3 位小数，净买入保留正负号
- 提示多空可在同一列用「多/空」合并展示

### 4. 不动的地方

- `query_trades` / `fetchTrades` / `TradeRow`：明细查询不动，避免破坏 LLM 已有用法
- `fetchLatestTradeData` / `fetchLatestNotionals`：服务于 `client list`，与本次需求无关
- `formatAmount` / `formatNet`：保持原行为，不影响其他展示路径

## 验证

1. `npm run build` 通过
2. CLI 命令：`trade summary date=20260424` 应输出 6 列表格 + 总计 2 行，金额一律「亿+3 位小数」
3. CLI/wework 对话："请汇总 4/24 交易日报" → LLM 表头使用 description 中的中文，所有数值带「亿」后缀且 3 位小数，不再出现 "T-1"
4. 抽查无空头管理人：空头列应显示 `0.000亿 / 0.000亿 / +0.000亿`

## 后续

- 如需在飞书/wework 卡片上也展示空头维度，可在 `src/feishu/formatter.ts` / `src/wework/formatter.ts` 单独排版（本次未涉及）
- 如需在 `query_trades` 明细查询里也暴露空头逐笔字段，可后续在 `TradeRow` 与 `query_trades` description 里追加，单独发起一次改动
