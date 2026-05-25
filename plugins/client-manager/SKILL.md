---
name: 客户管理操作指南
description: OTC 客户查询、状态管理、报价导入的使用指南
---

## 工具选择指南

| 用户意图 | 工具 |
|---|---|
| 查客户列表、筛选特定类型客户 | `query_clients` |
| 查某客户详情、报价条款（commission/financing/点差） | `view_client` |
| 查客户操作历史 | `get_client_history` |
| 新增客户 | `add_client`（管理员） |
| 修改客户信息或报价字段 | `update_client`（管理员） |
| 推进/回退客户阶段 | `advance_client` / `rollback_client`（管理员） |
| 删除客户 | `delete_client`（管理员） |
| 从 Excel 导入报价到客户属性 | `import_pricing_schedule`（管理员） |

重要区分：用户问"某客户的报价/commission/点差/financing/费率"时用 `view_client`，不要用 `query_pricing_quote`（后者是产品利率矩阵，属于 pricing 插件）。

## 关键词搜索规范（query_clients）

除非用户明确要求"所有客户"或"全部客户"，否则必须从用户问题中提取关键词传入 keyword 参数：
- "极速客户" → keyword="极速"
- "VIP客户" → keyword="VIP"
- "常速客户" → keyword="常速"
- "某某公司" → keyword="某某"

keyword 匹配范围：客户名称、企微群名、标签。

## 客户状态流转

```
Initial Contact → Requirement Discussion → Solution Design → UAT → PROD
```

- `advance_client`：推进到下一阶段
- `rollback_client`：回退到上一阶段
- 已在 PROD 的客户无法继续推进；已在 Initial Contact 的客户无法回退

## dry_run 二次确认流程

`delete_client` 和 `import_pricing_schedule` 都采用 dry_run 模式：
1. 第一次调用默认 `dry_run=true`，返回预览结果
2. 将预览结果展示给用户审阅
3. 用户明确确认后，再以 `dry_run=false` 调用执行实际操作

严禁跳过预览直接执行。

## view_client 报价字段说明

- `commission` — 佣金率
- `commission_cost` — 佣金成本
- `net_comm` — 净佣金
- `long_financing_spread` — 多头融资利差
- `short_financing` — 空头融资费率
- `index_hedging` — 是否指数对冲
- `is_ft` — 是否极速（FT）
- `pricing_range` — 同一管理人下多产品报价的 min/max 范围与来源产品列表
