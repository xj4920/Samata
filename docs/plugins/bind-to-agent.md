# 绑定 Agent

插件工具是否对某个 Agent 可见，由插件 scope 和 Agent 的工具配置共同决定。

## universal

`universal` 插件适合所有标准 Agent 都可能使用的通用能力，例如文件解析或格式转换。它默认加入可见工具池，再经过用户权限过滤。

## agent-bound

`agent-bound` 插件适合客户、交易、报价、健康、错题等业务专属能力。工具名必须写入 Agent 的 `tools_list` 才会对该 Agent 可见。

## 操作入口

Agent 绑定和工具配置可以通过 CLI 命令或数据库迁移完成。详细操作参考 [Plugin 绑定 Agent 操作指南](../plugin-bindto-agent-guide.md)。
