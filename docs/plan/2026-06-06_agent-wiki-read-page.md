---
docModules:
  - platform
  - external-data
docTopics:
  platform: Agent 工具
  external-data: Wiki 与文档源
canonicalDocs:
  - /platform/common-tools
  - /external-data/wiki-and-doc-sources
status: implemented
---

# Agent Wiki 页面读取修复

## 背景

TICLaw 在企业微信中先通过 `search_knowledge` 命中 wiki 页面，例如 `concepts/北向极速业务全景.md`、`insights/北向借券-业务方案填写逻辑.md`，随后调用 `read_knowledge_document` 读取这些路径时返回 `未找到文档`。现象看起来像 Agent 没有 wiki 权限，但实际原因是 `read_knowledge_document` 只读取 `documents` 表里的导入文档，不能读取 `data/wiki/<agent>/` 下的 wiki Markdown 页面。

## 决策

- 新增只读工具 `read_wiki_page`，专门读取 `search_knowledge` 返回的 `wiki[].page`。
- 保持 `read_knowledge_document` 只读取导入文档，避免混用 documents 表权限模型和 wiki 文件权限模型。
- `read_wiki_page` 只允许读取当前 Agent wiki 目录下的 `.md` 相对路径，禁止绝对路径和 `..` 路径片段。
- 将 `read_wiki_page` 加入 `COMMON_SET`，保证标准模式 Agent（包括 TICLaw）默认可用。
- 更新工具描述、TICLaw prompt 和通用 wiki guidance，明确 wiki 用 `read_wiki_page`，导入文档用 `read_knowledge_document`。

## 改动清单

- `src/tools/wiki-tools.ts`
  - 新增 `read_wiki_page` 工具定义和 handler。
  - 读取路径统一使用 `getAgentFsName(agent.id)` 定位当前 Agent wiki 目录。
  - 增加路径合法性校验、读取字符数上限和 frontmatter 标题/分类解析。
- `src/tools/knowledge-tools.ts`
  - 更新 `search_knowledge` / `read_knowledge_document` 描述，避免模型把 `wiki[].page` 当成 `document_id`。
  - 在 wiki/document 搜索结果中增加 `read_tool` 提示。
- `src/llm/tool-types.ts`
  - 新增 `ReadWikiPageInput` 类型。
- `src/llm/agents/config.ts`
  - 将 `read_wiki_page` 加入通用工具集。
- `src/llm/agents/prompt.ts`、`config/agents/ticlaw.md`
  - 明确 wiki 页面读取入口。
- `src/shared/cli-contract.ts`
  - 增加工具展示标签和读取结果摘要。
- `tests/unit/tools/wiki.test.ts`
  - 覆盖当前 Agent wiki 读取、路径穿越拒绝、跨 Agent 目录隔离、标准工具集可见性。

## 验证命令

```text
npm run test:unit -- tests/unit/tools/wiki.test.ts tests/unit/tools/knowledge.test.ts tests/unit/config/agent-config.test.ts
npx tsc --noEmit
npm run docs:plan-sync
npx tsx -e "<read_wiki_page smoke>"
docker compose build samata
docker compose up -d samata
docker exec samata sh -lc "<container read_wiki_page smoke>"
docker exec samata sh -lc "<container ticlaw tool availability smoke>"
git diff --check -- src/llm/tool-types.ts src/tools/knowledge-tools.ts src/tools/wiki-tools.ts src/llm/agents/config.ts src/llm/agents/prompt.ts config/agents/ticlaw.md src/shared/cli-contract.ts tests/unit/tools/wiki.test.ts docs/plan/2026-06-06_agent-wiki-read-page.md docs/.vitepress
```

## 验证结果

```text
npm run test:unit -- tests/unit/tools/wiki.test.ts tests/unit/tools/knowledge.test.ts tests/unit/config/agent-config.test.ts
# Test Files 3 passed (3), Tests 29 passed (29)

npx tsc --noEmit
# passed

npm run docs:plan-sync
# updated docs/.vitepress/plan-index.generated.ts
# 仍输出历史 plan frontmatter 缺失/为空的既有提示；本次新增 plan 无 canonicalDocs 错误。

npx tsx -e "<read_wiki_page smoke>"
# TICLaw 读取 concepts/北向极速业务全景.md 成功：
# title=北向极速业务全景, char_count=5866, returned_chars=1200, containsContent=true

docker compose build samata
# built samata:latest, image sha256:a2567d4071a950e06dadf6445bba1907c55ee1fb079e7445d2eb85c817c6ace3

docker compose up -d samata
# samata recreated and started; health check later became healthy

docker exec samata sh -lc "<container read_wiki_page smoke>"
# 容器内 TICLaw 读取 concepts/北向极速业务全景.md 成功：
# title=北向极速业务全景, char_count=5866, returned_chars=1200, containsContent=true

docker exec samata sh -lc "<container ticlaw tool availability smoke>"
# hasSearchKnowledge=true, hasReadWikiPage=true, hasReadKnowledgeDocument=true

git diff --check -- src/llm/tool-types.ts src/tools/knowledge-tools.ts src/tools/wiki-tools.ts src/llm/agents/config.ts src/llm/agents/prompt.ts config/agents/ticlaw.md src/shared/cli-contract.ts tests/unit/tools/wiki.test.ts docs/plan/2026-06-06_agent-wiki-read-page.md docs/.vitepress
# passed
```

## 构建与发布

- 该改动影响运行时工具定义、Agent 工具集和提示词，需要重建 Samata Docker image。
- 已重建 `samata:latest` 并重启 `samata` 容器，当前容器 health 为 healthy。
- 主仓同时配置 `origin` 与 `github` remote；若执行 push，需向两个 remote 推送同一分支。

## Commit Hash

待提交后补充。
