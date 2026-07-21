# 平台介绍

Samata 是多 Agent 智能助手平台，统一承载 CLI、飞书、企微和 Telegram 等入口。平台核心负责 Agent 配置、会话上下文、工具调度、知识与记忆注入、插件加载和运行观测。

## 模块边界

- **Agent 运行时**：根据当前用户、渠道和 Agent 配置构建 system prompt，完成 LLM 对话与工具调用。
- **通用能力**：提供 memory、knowledge、skill、document、todo、reminder、datetime、delivery 等平台级工具。
- **渠道接入**：CLI、飞书、企微、Telegram 共享 Agent 执行链路，但保留 channel 级身份与权限边界。
- **插件扩展**：业务专属工具通过插件加载，核心平台只保留通用能力和稳定接口。

## 阅读路径

1. [平台架构](./architecture.md)
2. [Agent 能力模型](./agent-capability-model.md)
3. [渠道与会话](./channels-and-sessions.md)
4. [通用工具](./common-tools.md)
5. [部署与模型](./deployment.md)
6. [观测与稳定性](./observability.md)
7. [场景回归评测](./scenario-regression.md)
