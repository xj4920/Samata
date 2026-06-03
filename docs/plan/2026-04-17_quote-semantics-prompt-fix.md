---
docModules:
  - external-data
docTopics:
  external-data: 报价与交易
canonicalDocs:
  - /external-data/pricing-and-trade
status: implemented
---

# 调整 prompt 区分两类"报价"语义

日期：2026-04-17

## 背景

用户问「鸣石的报价是多少？」本意是查询客户鸣石的 commission / financing 等条款（存在 `clients` 表），但当前 prompt 把「报价」一词绑定到 `query_pricing_quote`（产品利率矩阵，存在 `pricing_quotes` 表），会导致误路由。

## 两类"报价"对比

- **客户报价条款**：`commission`、`commission_cost`、`net_comm`、`long_financing_spread`、`short_financing`、`index_hedging`、`is_ft` — 工具 `view_client` / `query_clients` 已返回
- **产品利率报价**：FXD/FRN 货币 × 期限 × Fixed/Floating 矩阵 — 工具 `query_pricing_quote`

## 改动点（最小改动原则）

### 1. `src/llm/agents/prompt.ts`

把「工具使用规范」中原本的一条泛化报价指引拆成明确的二分规则：

- 问句主语是具体客户名（如"鸣石的报价"、"XX 的 commission / 点差 / financing / 费率 / 返佣"）→ 使用 `view_client`（或先 `query_clients` 定位），查看 commission / commission_cost / net_comm / long_financing_spread / short_financing / index_hedging / is_ft 等客户条款字段
- 问句主语是货币/期限/Fixed/Floating（如"USD 3M 固定利率"、"最新 FXD 报价"、"FXD_FRN Daily Update"）→ 使用 `query_pricing_quote` 查询产品利率报价矩阵
- 产品利率报价数据有时效性，禁止导入知识库，只存入 `pricing_quotes` 表

### 2. `src/tools/pricing-quote-tools.ts`

`query_pricing_quote` 的 description 开头补充：

> 仅用于查询产品利率报价矩阵（FXD/FRN 按货币/期限/Fixed/Floating）。……注意：查询具体客户的 commission/financing 等条款报价（如"鸣石的报价"）请使用 view_client，不要用本工具。

### 3. `src/tools/client-tools.ts`

`view_client` 的 description 从「查看某个客户的详细信息」扩展为：

> 查看某个客户的详细信息，包含客户报价条款字段：commission、commission_cost、net_comm、long_financing_spread、short_financing、index_hedging、is_ft。当用户问"某客户的报价/commission/点差/financing/费率/返佣"时使用本工具，不要用 query_pricing_quote（后者是产品利率矩阵）。

## 不改动

- 不改任何业务逻辑、表结构、工具参数
- 不改 `query_clients` 的 description（已正确说明按 keyword 筛选）
- 不新增工具

## 验证方式

1. 启动 agent，输入「鸣石的报价是多少？」，观察是否调用 `view_client(name_or_id="鸣石")` 而不是 `query_pricing_quote`
2. 输入「USD 3M 固定利率」，确认仍走 `query_pricing_quote`
3. 输入「最新 FXD 报价」，确认仍走 `query_pricing_quote`
