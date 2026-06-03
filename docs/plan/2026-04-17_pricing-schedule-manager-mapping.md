# Pricing Schedule 产品 → 管理人映射导入

## 背景

Pricing Schedule Excel 的 `Counterparty` 是**产品**维度（如 `VALEPINE`、`MINGSHIOPTIMA02`），而 `clients` 表是**管理人**维度（如 `磐松`、`鸣石`）。旧版 `importPricingSchedule` 直接用 `Counterparty.toUpperCase()` 匹配 `clients.name`，所以所有产品级行都匹配不到客户。

需求：通过 `config/customers.json` 将产品映射到管理人，再按管理人聚合 → 更新 `clients` 表的 commission / financing 字段。同一管理人下多个产品报价不一致时，保存 min/max range。

## 数据结构

`clients` 表新增一列 `pricing_range TEXT`，存 JSON：

```json
{
  "long_financing_spread": { "min": 0.01, "max": 0.01 },
  "short_financing":       { "min": 0.0075, "max": 0.0075 },
  "commission":            { "min": 0.00012, "max": 0.00016 },
  "commission_cost":       null,
  "net_comm":              { "min": 0.00002, "max": 0.00004 },
  "products": ["MINGSHIOPTIMA", "MINGSHIOPTIMA02", "MINGSHIOPTIMAX", "MINGSHIOPTIMAX02"]
}
```

原 5 个 REAL 列（`long_financing_spread` / `short_financing` / `commission` / `commission_cost` / `net_comm`）保留作为"代表值"：**取 range.min**。`pricing_range` JSON 是权威数据。

## 导入流程

1. `loadCustomers()` 构造产品（counter_party）→ 管理人映射（case-insensitive）
2. 对每行 Excel：
   - 先精确（ci）匹配产品名；失败则用 `productStringSimilarity` 找 top 1，score ≥ 0.6 才接受
   - 仍未命中 → 记入 `unmatched_products`（相同产品只报一次），附相似产品建议
3. 命中的行按管理人分组，每字段收集非 null 数值 → 计算 min/max；`index_hedging` 取 OR
4. 每组按管理人 name 去 `clients` 表匹配（ci 精确）：
   - 命中 → UPDATE 5 个 REAL 列 = min、`pricing_range` = JSON、`tags`（按 `classifyClient` 重新写入分类标签）
   - 未命中 → 记入 `missing_clients`，提示先 `add_client`
5. dry_run 为 true 时只返回预览，不写入

返回值：

```ts
{ success: true, imported, skipped_products, details,
  unmatched_products: [{ counterparty, suggestions }],
  missing_clients: [{ manager, products }] }
```

## 改动文件

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/db/schema.ts` | 新增 migration `add-pricing-range-column`，`ALTER TABLE clients ADD COLUMN pricing_range TEXT` |
| 2 | `src/models/client.ts` | `Client` 接口新增 `pricing_range: string \| null` |
| 3 | `src/commands/client.ts` | 重写 `importPricingSchedule`：产品→管理人聚合、min/max range；新增导出 `PricingRange` 类型和 `parsePricingRange` / `formatFieldWithRange` 辅助；`view` 展示 range 与来源产品；`update` / `updateClient` allowed 列表加 `pricing_range` |
| 4 | `src/tools/client-tools.ts` | `query_clients` / `view_client` 返回值附 parsed `pricing_range`；`import_pricing_schedule` 工具描述说明"按管理人聚合；未知产品需管理员维护 customers.json"；`update_client` 描述补充 `pricing_range` 字段 |
| 5 | `docs/plan/2026-04-17_pricing-schedule-manager-mapping.md` | 本文件 |

## 未知产品的错误提示

```
⚠️ 以下产品未在 config/customers.json 中找到对应管理人，已跳过：
  - VALEPINE（相似产品: valepine, ...）
请联系管理员在 config/customers.json 中维护产品 → 管理人映射关系后重试。
```

## 代表值：为什么选 min

- 销售对外报价常用"最低可达 x bp"，min 语义直观
- 不混入平均数这种人造值
- pricing_range JSON 为权威源，view / tool 返回同时展示 min/max，REAL 列仅作快速筛选和向后兼容

## 不做

- 不改 `pricing_quotes` 表（产品利率矩阵，是另一条链路）
- 不自动创建缺失的 client 行
- 不处理 Index Hedging 多值冲突的范围（只做 OR 合并）

## 状态

- [x] 已执行完成
