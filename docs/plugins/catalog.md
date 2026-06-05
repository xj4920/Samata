# 插件目录

当前插件体系按业务边界划分。工具名尽量保持兼容，迁移后 Agent 配置不需要因为来源变化而改写 prompt。

## 典型插件

- **client-manager**：客户信息、客户报价条款、客户操作事件。
- **trade-query**：交易查询、交易汇总、CSV 导出。
- **pricing**：产品利率报价导入与查询。
- **hedge-ratio**：对冲比查询和后台监控。
- **wework-qa**：企微 QA 提取和消息监测。
- **wrong-questions**：错题记录与复习状态。
- **wiki-sync**：Confluence / Wiki 同步后台服务。

## 核心保留

memory、knowledge、skill、document、todo、reminder、datetime、delivery 等通用能力仍属于核心平台。
