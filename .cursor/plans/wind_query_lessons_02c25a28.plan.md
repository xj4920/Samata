---
name: Wind query lessons
overview: 将 Wind 数据库查询经验教训固化到 docs/wind-database.md，并微调 otcclaw.md 路由指引，与 InfluxDB 方案对称。
todos:
  - id: wind-add-pitfalls
    content: 在 docs/wind-database.md 末尾新增"常见陷阱与最佳实践"节，覆盖 7 个教训
    status: completed
  - id: wind-update-routing
    content: 微调 config/agents/otcclaw.md Wind 路由指引，强化错误排查和陷阱提示
    status: completed
isProject: false
---

# Wind 数据库查询经验固化方案

## 策略

与 InfluxDB 方案一致：经验写进按需读取的参考文档 [docs/wind-database.md](docs/wind-database.md)，不浪费每次对话的 token 预算。otcclaw.md 的路由指引做轻微强化。

## 具体改动

### 1. 在 `docs/wind-database.md` 末尾新增"常见陷阱与最佳实践"节

在现有"注意事项"（5 条，第 176-181 行）之后，追加 `## 常见陷阱与最佳实践`，覆盖以下教训：

- **列名拼写错误**：如 `TOT_SHHLDR_EQY_EXCL_MIN_INT` 少写了 R，正确为 `TOT_SHRHLDR_EQY_EXCL_MIN_INT`。PostgreSQL 的 HINT 会给出建议列名，应优先参考
- **列名不存在**：如 `S_VAL_PB` 在 ASHAREEODDERIVATIVEINDICATOR 表中不存在（只有 `S_VAL_PE` / `S_VAL_PS`）；`EST_YEAR` 在 ASHARECONSENSUSDATA 中不存在，正确为 `EST_REPORT_DT`。**写 SQL 前必须 `read_file docs/wind-tables-schema.md` 确认列名**
- **估值指标返回 NULL**：部分表的最新日期可能尚未有数据（延迟更新），查到 NULL 时应检查该表实际最新日期 (`MAX("TRADE_DT")`)，或换用其他表
- **Wind 代码格式**：必须带市场后缀（`.SZ` / `.SH` / `.HK`），不带后缀会查不到数据
- **错误排查兜底**：遇到列名错误时，用 `information_schema.columns` 查表实际结构；数据为空时先查 `MIN/MAX` 确认数据范围
- **避免 SELECT \***：数据量大、性能差，且无法及早发现列名错误；应明确指定所需列
- **多表 JOIN 指定表别名**：避免列名歧义（如 `S_INFO_WINDCODE` 在多表都存在）

### 2. 微调 `config/agents/otcclaw.md` 的 Wind 路由指引（第 84-91 行）

当前第 87 行已有"禁止凭印象猜测列名"的提示，但缺少"遇到错误时的兜底方法"和"注意常见陷阱"的引导。在步骤 2 后补一句强化，并在最后加一条提示读常见陷阱节。

改动范围很小：
- 步骤 2 补充：列名不确定时用 `information_schema.columns` 兜底查实际结构
- 末尾加一条：**特别注意 `docs/wind-database.md` 末尾"常见陷阱与最佳实践"一节**

## 不改动的部分

- `docs/wind-tables-schema.md` — 纯 schema 参考文档，不混入经验教训
- Dream / Memory 系统 — 与 InfluxDB 方案一致，不改
