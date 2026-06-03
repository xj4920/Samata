# Pricing Schedule 工具路由修复

## 背景

用户上传 `Pricing+Schedule_CLAW.xlsx` 后，LLM 没有调用专用工具 `import_pricing_schedule`，而是：

1. 先用 `parse_excel` 读出表格内容
2. 对文件中的每个 Counterparty（`WIZARD01`/`MINGSHIOPTIMA`/`INVESTINGFORMULA` 等产品名）逐个调用 `query_clients(keyword=...)`
3. 由于 `clients` 表的 `name` 列存的是**管理人名**（`宽德`、`鸣石`、`稳博`），按 Counterparty 查一定是空，于是 LLM 报告"客户未找到"

实际上 `config/customers.json` 是 **管理人 → 产品（counter_party）** 的 1:N 映射；LLM 有两条现成路径可以解出管理人：

- `list_customers` 工具（`src/tools/trade-tools.ts`）
- `import_pricing_schedule` 工具（`src/tools/client-tools.ts`），内部调 `loadCustomers()` 自动按管理人聚合

根因是三处提示词（system prompt、bot 文件注入提示、parse_excel 工具描述）都没明确把 Pricing Schedule 这条路径写清楚，LLM 默认被引向 `parse_excel`。本计划在三处同时加固。

## 改动

### 1. `src/llm/agents/prompt.ts`（system prompt）

把原先单一的 FXD_FRN 规则扩展成三块：

- **报价类 Excel 文件识别与路由**：明确"Pricing Schedule / CLAW / 客户报价"关键字 → 必须用 `import_pricing_schedule`（dry_run 预览）；FXD/FRN → 必须用 `import_pricing_quote`；两者语义区分（客户报价条款表 vs 产品利率矩阵）；`unmatched_products` 不要 `add_client`。
- **管理人/交易对手映射**：解释 `config/customers.json` 的 1:N 结构，`query_clients` 只能按管理人名匹配，用 Counterparty 查空是**正常现象**，应先调 `list_customers` 或直接用 `import_pricing_schedule`。
- **"报价"问答语义**：客户名主语 → `view_client`；货币/tenor 主语 → `query_pricing_quote`。

### 2. `src/runtime/file-hint.ts`（新增）+ wework / feishu bot

抽出公共 `buildFileHint(filename, savedPath, bytes)`：

- 文件名匹配 pricing schedule / claw / 客户报价 → 追加 `请直接调用 import_pricing_schedule`
- 文件名匹配 fxd / frn → 追加 `请直接调用 import_pricing_quote`
- 其他 → 沿用 `parse_word / parse_excel / read_file` 通用提示

然后 `src/wework/bot.ts` 与 `src/feishu/bot.ts` 的文件下载分支各自替换为 `buildFileHint(...)`。

### 3. ~~`plugins/excel-parser/index.ts`（parse_excel 描述反引导）~~（已放弃）

原计划在 `parse_excel.description` 追加"若是 Pricing Schedule/FXD 文件改用 import_* 工具"的反引导，后评估为**违反分层**：插件不应知道 server 端 native tool 的存在。反引导完全交给 server 端的 system prompt（改动 1）和 file-hint（改动 2）承担；插件描述保持中立，仅说明自身能力。

## 不改的

- `config/customers.json`、`loadCustomers`、`importPricingSchedule` 业务逻辑未动——后端映射已经是对的
- `query_clients` 仍然只查管理人表，不做"按 counter_party 自动兜底"
- `list_excel_sheets` 描述未动

## 验证

1. 重启 server，重发 `Pricing+Schedule_CLAW.xlsx`，预期 LLM 直接调 `import_pricing_schedule(dry_run=true)`，并在结果里正确聚合：
   - `WIZARD01~04` → 宽德
   - `MINGSHIOPTIMA` → 鸣石
   - `INVESTINGFORMULA` → 稳博
2. 发任意普通 `.xlsx`（非报价）→ 仍可走 `parse_excel`
3. 发 `FXD_FRN_Daily Update.xlsx` → 走 `import_pricing_quote`，不退化

## 状态

- [x] 已执行
