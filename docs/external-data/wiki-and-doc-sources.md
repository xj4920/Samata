# Wiki 与文档源

Samata 同时支持用户导入文档、Markdown/Grep 检索和 Wiki/Confluence 同步。目标是让 Agent 能读取结构化知识，也能回溯原始资料来源。

## 文档导入

导入文档后，平台保存文档元数据和解析产物，并让知识检索能按 Agent 范围查询。

## Wiki 层

Wiki 页面用于把零散文档整理成链接型知识库。Confluence 同步可作为后台插件运行，把外部页面归档成 Markdown。

## 检索原则

先读结构化 Wiki 或知识条目；不足时再回到原始文档。文档路径按 Agent 隔离，避免跨 Agent 泄露资料。
