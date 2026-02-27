# Project Memory

## 环境规范
- 永远使用本地的 venv 环境执行 Python 命令（`source venv/bin/activate` 或使用 `venv/bin/python`）

## 架构规范
- Agent tools（`src/llm/agent.ts` 中的 tool handlers）必须复用 `src/commands/` 下已有的命令函数，禁止在 handler 中重新实现业务逻辑
- 命令函数应导出可复用的数据函数（如 `fetchTrades`），tool handler 只做薄包装：调用命令函数 → JSON.stringify 返回结果
- 新增 tool 时，先在 `src/commands/` 中实现并导出核心逻辑，再在 agent.ts 中添加 tool 定义和 handler 调用
