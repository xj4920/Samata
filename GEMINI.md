# Project Memory & Execution Plan

## 核心执行规范 (Execution Plan Management)
**强制要求：先做计划，再编码！**
在执行任何中大型需求或代码重构之前，必须先在 `docs/plan` 目录下创建执行计划文档。
- **保存位置**: `docs/plan/`
- **命名规则**: `yyyy-mm-dd_{function_description}.md` (例如: `2024-03-16_agent-rbac-auth.md`)
- **计划内容应包含**: 需求理解、影响范围、详细实施步骤、验收标准。在计划得到确认后再开始实施编码。

## 环境规范
- 永远使用本地的 venv 环境执行 Python 命令（`source venv/bin/activate` 或使用 `venv/bin/python`）
- **严禁在代码中 hardcode 绝对路径**。所有路径必须通过环境变量、配置文件或相对路径获取，不得在源码中写死如 `/Users/xxx/...` 这类绝对路径。

## 项目结构规范
- `scripts/` 目录仅存放脚本，严禁在其中编写业务代码
- 所有代码统一放到 `src/` 目录，按功能分类管理
- 新增：执行计划文档必须存放在 `docs/plan/` 目录下

## 数据注意事项
- `knowledge_pending` 表的 `auto_quality_score` 字段 99% 为 NULL（仅 5 条有值），不可用作排序或筛选依据

## 架构规范

### 命令与工具复用
- Agent tools（`src/llm/agent.ts` 中的 tool handlers）必须复用 `src/commands/` 下已有的命令函数，禁止在 handler 中重新实现业务逻辑
- 命令函数应导出可复用的数据函数（如 `fetchTrades`），tool handler 只做薄包装：调用命令函数 → JSON.stringify 返回结果
- 新增 tool 时，先在 `src/commands/` 中实现并导出核心逻辑，再在 agent.ts 中添加 tool 定义和 handler 调用

### Bot 与 CLI 逻辑一致性（重要）
**原则：CLI 是标准实现，所有 bot（飞书、Telegram 等）必须与 CLI 保持完全一致**

#### Agentic Chat 逻辑共享
- **禁止**在 bot 中重复实现 agentic loop（tool use 循环）
- **必须**使用 `src/llm/agent.ts` 中的 `runAgenticChat()` 函数
- **必须**使用相同的 tools（通过 `getTools()`）和 system prompt（通过 `getSystemPrompt()`）

#### 修改 Agentic 逻辑时
- 只需修改 `src/llm/agent.ts` 中的 `runAgenticChat()` 函数
- 所有入口（CLI、飞书、Telegram）会自动保持一致
- 无需在多个地方同步修改
