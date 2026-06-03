# Agent 维度报价上传与询价功能

## 背景

当前系统已有 `import_pricing_schedule` 工具，用于导入客户维度的 Pricing Schedule（Counterparty -> 融资/佣金字段），数据写入 `clients` 表。

现在需要支持另一类报价文件——**产品维度的利率报价表**，如 `FXD_FRN_Daily Update`，特点：
- 非客户维度，而是**产品利率报价**（Fixed/Floating x Currency x Tenor）
- **有时效性**，每日/每周更新，不适合导入知识库
- 需要支持**自然语言询价**（如"USD 3M FXD 利率是多少？"）

### FXD_FRN_Daily Update 文件结构

单个 sheet，14 行 x 7 列：

```
Row 0: Issuer: GF Global Capital Limited
Row 1: Guarantor: GF Holdings (Hong Kong) Corporation Limited, BBB by Fitch
Row 2: Coupon per annum, paid Qrtly/Semi/Annually | >= USD 5,000,000 Notional
Row 3: Fixed | USD | HKD | CNH           <-- 表头行
Row 4-7: 1M/2M/3M/6M | rate | rate | rate  <-- Fixed 利率
Row 8: (空行)
Row 9: Floating | USD | HKD | CNH        <-- 表头行
Row 10-13: 1M/2M/3M/6M | rate | rate | rate <-- Floating 利率
```

## 设计方案

### 1. 新建 `pricing_quotes` 表（持久化存储）

不使用 `/tmp` 临时目录，也不进知识库。新建专用表：

```sql
CREATE TABLE IF NOT EXISTS pricing_quotes (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  quote_type  TEXT NOT NULL,       -- 报价类型标识，如 'fxd_frn'
  quote_date  TEXT NOT NULL,       -- 报价日期，如 '2026-04-13'
  file_name   TEXT,                -- 原始文件名
  data        TEXT NOT NULL,       -- JSON 格式的结构化报价数据
  metadata    TEXT,                -- JSON 元信息（issuer, guarantor, notional 等）
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pricing_quotes_agent_type
  ON pricing_quotes(agent_id, quote_type, quote_date);
```

- `data` 字段存 JSON：`[{"type":"Fixed","tenor":"1M","USD":0.0388,"HKD":0.0229,"CNH":0.0136}, ...]`
- 同一 `agent_id + quote_type + quote_date` 的记录会被覆盖（UPSERT）
- **保留历史**：不同日期的报价各自保存，可追溯

### 2. 报价文件解析器（`src/commands/pricing-quote.ts`）

新建模块，负责：
- **解析 FXD_FRN Excel**：识别 Fixed/Floating 区块，提取 tenor x currency 利率矩阵
- **入库**：写入 `pricing_quotes` 表（UPSERT by agent_id + quote_type + quote_date）
- **查询**：按 agent_id + quote_type 查最新报价，或按日期范围查历史
- 从文件名中提取日期（如 `20260413`），或用当前日期

解析逻辑采用**位置识别**方式（非列头匹配），因为 FXD_FRN 文件格式比较固定：
1. 扫描行，找到 `Fixed` 或 `Floating` 关键字所在行作为区块头
2. 同行右侧为货币列头（USD, HKD, CNH）
3. 下方连续非空行为 tenor 行（1M, 2M, 3M, 6M）

### 3. Agent Tools（`src/tools/pricing-quote-tools.ts`）

新建工具模块，注册到 `src/tools/index.ts`：

- **`import_pricing_quote`**：上传并解析报价文件
  - 输入：`file_path`（必填）、`quote_type`（可选，默认从文件名推断）、`dry_run`（可选）
  - 行为：解析 Excel -> 预览/入库 -> 返回结构化结果
  - 权限：agent admin

- **`query_pricing_quote`**：查询报价数据
  - 输入：`quote_type`（可选）、`date`（可选，默认最新）、`currency`（可选）、`tenor`（可选）、`rate_type`（可选，Fixed/Floating）
  - 行为：从 `pricing_quotes` 表中查询并返回格式化结果
  - 权限：agent 成员均可

### 4. 文件上传流程（沿用现有模式）

文件上传**沿用现有 bot 文件消息处理流程**，不需要修改：
1. 用户在企微/飞书发送 Excel 文件
2. Bot 下载文件 -> `saveUploadedFile` 保存到 `/tmp/samata/uploads/`
3. 注入用户消息，提示 agent 可用工具
4. Agent 自主调用 `import_pricing_quote` 或 `parse_excel`

无需改动 `src/wework/bot.ts` 或 `src/feishu/bot.ts`。

但需要在 **system prompt** 中增加指引：当收到 `FXD_FRN` 相关文件时，优先使用 `import_pricing_quote` 而非 `parse_excel`。

### 5. 自然语言询价

通过 `query_pricing_quote` 工具 + system prompt 指引实现：
- Agent 的 system prompt 中说明报价数据结构和查询方式
- 用户问"USD 3M 固定利率？" -> agent 调用 `query_pricing_quote(currency='USD', tenor='3M', rate_type='Fixed')`
- 用户问"最新 FXD 报价？" -> agent 调用 `query_pricing_quote(quote_type='fxd_frn')`

不需要向量搜索或知识库，纯结构化查询即可。

### 6. 可扩展性

`pricing_quotes` 表的 `quote_type` 字段预留了扩展空间。未来如果有其他类型的报价（如期权报价、雪球报价），只需：
1. 在 `src/commands/pricing-quote.ts` 中新增解析函数
2. 注册新的 `quote_type`

## 改动文件清单

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/db/schema.ts` | 新增 `pricing_quotes` 表 migration |
| 2 | `src/commands/pricing-quote.ts` | **新建**：FXD_FRN 解析器 + 入库/查询函数 |
| 3 | `src/tools/pricing-quote-tools.ts` | **新建**：`import_pricing_quote` + `query_pricing_quote` 工具定义和 handler |
| 4 | `src/tools/index.ts` | 注册 `pricingQuoteTools` 模块 |
| 5 | `src/llm/tool-types.ts` | 新增 `ImportPricingQuoteInput` / `QueryPricingQuoteInput` 类型 |

## 状态

- [x] 已执行
