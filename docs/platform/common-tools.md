# 通用工具

通用工具是所有标准 Agent 可以复用的平台能力。它们与业务插件不同，默认属于核心平台，数据也通常写入主库。

## 工具类型

- **记忆与知识**：memory、knowledge、document import、wiki 写入。
- **个人效率**：todo、reminder、schedule、datetime。
- **文件与交付**：附件处理、Markdown 渲染、图片/文件发送。
- **系统辅助**：状态查询、模型切换、HTTP 请求、基础文件读取。

## 权限口径

通用工具不代表所有用户都可写。导入、删除、更新类工具仍会经过 Agent Admin、System Admin 或 user blocklist 检查。

## 演进方向

核心平台只保留跨 Agent 通用且稳定的能力；业务专属工具应迁入插件，由 Agent 的 `tools_list` 决定可见性。
