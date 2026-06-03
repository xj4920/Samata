# 平台架构

Samata 的主进程负责数据库、Bot 接入、CLI API、插件注册和 Agent 执行。CLI 是轻量客户端，通过 HTTP/SSE 与服务端通信；Bot 渠道也进入同一套 Agent 执行链路。

```text
CLI / Feishu / Telegram / WeWork
             |
             v
Samata server: CLI API + Bot adapters + Plugin registry + SQLite
             |
             v
Agent runtime: prompt build + tool routing + memory/knowledge/skill injection
```

## 核心职责

- **主库**：保存 users、agents、agent_members、knowledge、skills、memory、documents、reminders、todos、bot apps、events 等平台实体。
- **Agent 配置**：Agent 定义由数据库管理，prompt 模板保留在 `config/agents/*.md`。
- **工具入口**：核心工具、插件工具和 MCP 工具合并后，再按 Agent 与用户权限过滤。
- **插件注册**：插件通过统一 SDK 提供工具、生命周期和私有数据目录。

## 平台边界

核心平台不承载业务专属数据模型。客户、交易、报价、健康、错题、企微 QA 等业务能力由插件负责，工具名对 Agent 保持稳定。
