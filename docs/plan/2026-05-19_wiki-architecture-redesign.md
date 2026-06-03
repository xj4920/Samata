---
docModules:
  - external-data
docTopics:
  external-data: Wiki 与文档源
canonicalDocs:
  - /external-data/wiki-and-doc-sources
status: implemented
---

# Wiki Architecture Redesign: 从编译型百科到链接型文档库

## 概述

将 wiki 从有损编译摘要改为以文档为源的聚合索引 + 动态链接发现，支持 Xbase 批量导入与文档修正后 wiki 联动更新。

## 目标架构

```
多来源导入                           搜索/提问
(文件/飞书/API)                         |
      |                          grep documents + wiki
      v                                 |
import_document                   发现跨文档关联
      |                                 |
      v                           持久化新 link
parsed.md (全文)  <--- wiki compile --->  Wiki 层
                                    |
                          entity/concept 聚合页
                          (指向文档, 不是摘要)
```

## 分阶段实现

### Phase 1: entity 页面从「摘要」变「聚合索引」 ✅

- compile prompt 输出 `related` 字段，取消 300 字限制
- `writePage` 按文档标题 section merge（`### 文档标题`）
- frontmatter: `sources`, `related`
- body: `## 文档提及` + `## 关联`（wikilinks）
- `rebuildIndex` 显示 related 摘要

**实现**: [`src/services/wiki-compile.ts`](src/services/wiki-compile.ts)

### Phase 1.5: Document 修正 → Wiki 联动 ✅

- `purgeDocumentFromWiki(agentId, docTitle)` — 删除该文档在所有 entity/concept 页的 section
- `recompileDocument(agentId, docId)` — purge + 重编译
- 工具 `recompile_document`（[`src/tools/wiki-tools.ts`](src/tools/wiki-tools.ts)）

### Phase 2: 动态 link 发现 ✅

- `discoverLinks()` in [`src/services/wiki-links.ts`](src/services/wiki-links.ts)
- `fetchKnowledge` 返回后 fire-and-forget
- 共现计数持久化在 `data/wiki/<agent>/.link-cooccurrence.json`
- 默认 `WIKI_LINK_MIN_COOCCUR=2` 后才写入 `related`

### Phase 3: Xbase 批量导入 ✅

- [`scripts/import-xbase.ts`](scripts/import-xbase.ts)
- 递归扫描 `.md/.docx/.pdf/.txt/.xlsx/.csv`
- 通过 CLI API `/doc-import`
- 断点续传: `data/import-xbase-state.json`

### Phase 4: 搜索从 wiki 入手 ✅

- `searchWikiEntitiesExact()` — title/related 精确匹配（高 relevance）
- `fetchKnowledge` 顺序: wiki exact → wiki grep → documents → FAQ
- [`src/commands/knowledge.ts`](src/commands/knowledge.ts)

## 不改的部分

- `import_document` 全文存储 + hash 去重 + 异步 compile
- `parsed.md` 格式
- 飞书 bot 导入流程
- FAQ (`knowledge` 表) 独立存在

## 风险与注意事项

- 200+ 文件 compile 成本：需 Layer 0 并行（见 `2026-05-19_wiki-compile-performance.md`）
- entity 命名一致性：prompt 要求复用已有名，大批量后可能需手动合并
- 动态 link 噪声：`WIKI_LINK_MIN_COOCCUR` 阈值可调
