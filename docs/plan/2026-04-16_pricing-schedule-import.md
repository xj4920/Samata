---
docModules:
  - external-data
docTopics:
  external-data: 报价与交易
canonicalDocs:
  - /external-data/pricing-and-trade
status: implemented
---

# 客户报价 Excel 导入优化

## 背景

用户通过企微 channel 上传客户报价文件（Pricing Schedule_CLAW.xlsx），需要将报价属性添加到客户系统中，并自动分类客户。

## 需求

### 1. 删除 long_pnl_spread / short_pnl_spread 字段

- 数据库 migration 中移除这两列
- Client 接口、CLI 命令、Agent Tool 中同步移除
- Excel 导入时忽略这两列（若存在）

### 2. 企微发送 Excel + 导入确认

- 企微 bot 已支持文件消息（`handleFileMessageForInstance`），用户发文件后 bot 下载保存并通知 agent
- `import_pricing_schedule` 改为两步模式：
  - `dry_run: true`（默认）→ 只预览匹配结果，不写入数据库
  - `dry_run: false` → 用户确认后实际执行导入
- Agent 在企微对话中先展示预览，用户回复确认后再执行

### 3. 未匹配客户模糊推荐

- Excel 中 Counterparty 在系统中找不到精确匹配时，用字符串相似度算法推荐最可能的前 3 个客户
- 用户可选择推荐客户进行关联，或跳过

### 4. 客户分类逻辑（仅限极速客户）

**前提条件**：此分类逻辑仅在**北向极速业务**语境下成立，需结合 `is_ft` 字段判断客户是否为极速客户，仅 `is_ft = true` 时才适用此分类。

- **原逻辑（错误）**：根据 `Index Hedging?` 判断 → SCHONFELD/valepine 有 Short Financing 但 Index Hedging=false，会被误判为多空客户
- **新逻辑（正确）**：仅当 `is_ft = true` 时，根据 `Short Financing` 是否为空判断
  - `Short Financing 为空` → **多空客户**（空头为股票，无 Index Swap 融资）
  - `Short Financing 不为空` → **中性客户**（空头为 Index Swap，有融资利率）
  - `is_ft = false` → 不适用此分类，不自动打标签

数据验证（均为极速客户）：

| Counterparty | Short Financing | Index Hedging | 正确分类 |
|---|---|---|---|
| LINKRIVER | null | false | 多空客户 |
| MINGSHIOPTIMA | null | false | 多空客户 |
| MINGSHIOPTIMA02 | null | false | 多空客户 |
| AQUILA | 0.0075 | true | 中性客户 |
| EXPEDITION | 0.01 | true | 中性客户 |
| SCHONFELD | 0.0075 | false | 中性客户 |
| valepine | 0.01 | false | 中性客户 |

### 5. 字段单位统一

Excel 中各字段单位不一致，导入 SQLite 时需统一为小数：

| 字段 | Excel 原始值示例 | Excel 单位 | 导入 SQLite 值 | 转换规则 |
|---|---|---|---|---|
| Long Financing Spread | 0.01 | 小数 | 0.01 | 原值 |
| Short Financing | 0.0075 | 小数 | 0.0075 | 原值 |
| Commission | 1.6 | 0.0001（bp） | 0.00016 | × 0.0001 |
| Commission Cost | 1.2 | 0.0001（bp） | 0.00012 | × 0.0001 |
| Net Comm | 0.4 | 0.0001（bp） | 0.00004 | × 0.0001 |

导入时 Commission / Commission Cost / Net Comm 需乘以 0.0001 转换，与 Financing 字段保持一致的小数单位。

## 改动文件

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/db/schema.ts` | migration 移除 long_pnl_spread / short_pnl_spread 列；新增 is_ft 列（INTEGER，默认 0） |
| 2 | `src/models/client.ts` | Client 接口移除 long_pnl_spread / short_pnl_spread，新增 is_ft；classifyClient 参数改为 (isFt, shortFinancing)，仅 isFt=true 时才分类 |
| 3 | `src/commands/client.ts` | view 显示、update allowed 移除旧字段并新增 is_ft；importPricingSchedule FIELD_MAP 移除旧字段、忽略旧字段、新增 is_ft；Commission/CommissionCost/NetComm 导入时 × 0.0001；classifyClient 调用参数更新；importPricingSchedule 支持 dry_run；未匹配项增加模糊推荐 |
| 4 | `src/tools/client-tools.ts` | query_clients / view_client 返回值移除旧字段、新增 is_ft；classifyClient 调用参数同步修改；工具描述更新 dry_run 说明 |
| 5 | `src/llm/tool-types.ts` | ImportPricingScheduleInput 增加 dry_run 字段 |

## 客户分类逻辑

**适用范围**：仅限 `is_ft = true` 的客户（北向极速业务）

根据 `is_ft` + `Short Financing` 字段自动分类：
- **is_ft = false** → 不适用此分类，不自动打标签
- **is_ft = true 且 Short Financing 为空（null）** → **多空客户**（空头为股票，北向极速业务下无 Index Swap 融资利率）
- **is_ft = true 且 Short Financing 不为空** → **中性客户**（空头为 Index Swap，有融资利率）

分类标签写入客户 `tags` 字段，并在 list / view / query_clients / view_client 中展示。

## 状态

- [x] 已执行完成
