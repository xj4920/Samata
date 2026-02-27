# Project Memory

## 环境规范
- 永远使用本地的 venv 环境执行 Python 命令（`source venv/bin/activate` 或使用 `venv/bin/python`）

## 数据注意事项
- InfluxDB（`messages` 库 `wework` 表）的 `time` 字段存储的是北京时间（CST），但标记为 UTC（`Z` 后缀）。实际 UTC = 存储时间 - 8 小时。做时间过滤时需加 8 小时偏移对齐。

## 架构规范
- Agent tools（`src/llm/agent.ts` 中的 tool handlers）必须复用 `src/commands/` 下已有的命令函数，禁止在 handler 中重新实现业务逻辑
- 命令函数应导出可复用的数据函数（如 `fetchTrades`），tool handler 只做薄包装：调用命令函数 → JSON.stringify 返回结果
- 新增 tool 时，先在 `src/commands/` 中实现并导出核心逻辑，再在 agent.ts 中添加 tool 定义和 handler 调用
