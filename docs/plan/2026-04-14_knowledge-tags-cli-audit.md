# CLI：知识标签与 monitor 白名单核对

## 背景

`config/monitor.json` 的 `knowledge.tags.<agentId>` 定义各 Agent 知识库标签白名单；`document-import` 已用其补充候选标签。需要 CLI 主动发现库中 **已存在** 条目里不在白名单的标签，并引导修正。

## 实现

- 新模块 [`src/commands/knowledge-tag-audit.ts`](../../src/commands/knowledge-tag-audit.ts)：`loadKnowledgeTagsFromConfig`（供 `document-import` 复用）、`rankTagCandidates`、`cliAuditKnowledgeTags`。
- 路由命令：`/faq-tags-check`（`requiredRole: agent_admin`），见 [`src/commands/router.ts`](../../src/commands/router.ts)。
- 交互：`remoteSelect` / `remoteConfirm`，依赖 CLI SSE 的 `promptFn`（与 `/faq-update` 交互模式一致）。

## 行为摘要

1. 读取当前 Agent 的 `knowledge.tags`；未配置则提示并退出。
2. 查询 `knowledge_agents` 关联的知识，筛出 tags 中含白名单外 token 的条目。
3. 每条：按问题+答案对白名单标签打分，展示前 3 个候选 +「仅移除非法标签」+「跳过」；确认后 `updateKnowledgeById` 写回。
