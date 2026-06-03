# 工具可见性

工具可见性由工具来源、Agent 配置和用户权限共同决定。

## 工具来源

- **Core tools**：核心平台提供的通用工具。
- **Plugin tools**：插件提供的业务工具。
- **MCP tools**：外部 MCP server 动态提供的工具。

## Agent 过滤

标准 Agent 会看到 `COMMON_SET`、显式配置的 `tools_list`、可见的 universal plugin tools 和可用 MCP tools。`agent-bound` 插件工具只有出现在 Agent 的 `tools_list` 中才可见。

## 用户过滤

Agent 成员可以通过 `user_tools_list` 或 blocklist 进一步限制工具。导入、删除、写入、系统操作类工具必须在 handler 内再次校验权限。
