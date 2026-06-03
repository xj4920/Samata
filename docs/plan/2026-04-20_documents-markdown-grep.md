---
docModules:
  - platform
  - external-data
docTopics:
  platform: 文档与知识
  external-data: Wiki 与文档源
canonicalDocs:
  - /platform/agent-capability-model
  - /external-data/wiki-and-doc-sources
status: implemented
---

# 执行计划：文档知识从 DB 存储改为 Markdown 文件 + Grep 查询

> 日期：2026-04-20
> 状态：待实施

## 1. 背景

当前文档上传流程：**文件 → 解析 → 拆分 chunk → 存入 `knowledge` 表 → SQLite LIKE + CJK bigram 查询**

问题：
- chunk 拆分丢失上下文（一个文档被切成多个独立行，搜索结果只见片段不见全文）
- DB LIKE 对中文效率低，需要 bigram 展开 hack
- 修改/重新导入文档需同步更新多条 knowledge 行
- parsed.md 文件已在磁盘上存在，chunk 行是冗余存储

**现状数据**：835 条手动 FAQ（`document_id IS NULL`）+ 23 条文档 chunk（`document_id IS NOT NULL`），全部归属 `agent-otcclaw`。

**核心洞察**：两类数据本质不同——手动 FAQ 是结构化 Q&A、CRUD 频繁，适合 DB；文档 chunk 是长文本、导入后只读，适合文件存储 + grep。

## 2. 方案：混合架构

### 2.1 保留 DB 的部分

| 组件 | 说明 |
|------|------|
| 手动 FAQ | `knowledge` 表中 `document_id IS NULL` 的行，保持现有 LIKE + bigram 搜索 |
| `documents` 表 | 保留文档元数据（title, agent_id, created_by, stored_path），用于列表/删除/重导入 |
| `knowledge_agents` 表 | 继续为手动 FAQ 提供 agent 隩离 |

### 2.2 改为文件的部分

- **文档 chunk**（`knowledge` 表中 `document_id IS NOT NULL` 的行）：删除 DB 行，改用磁盘上的完整文档文件 + ripgrep 搜索
- 文档文件按 **agent 维度** 组织目录结构，每个 parsed.md 注入 YAML frontmatter

## 3. Agent 维度的文档目录结构

当前 `data/documents/<docId[:8]>/` 是扁平结构，不体现 agent 归属。改为按 agent 分组：

```
data/documents/
  agent-otcclaw/
    87bfe9b9/
      original.docx      # 原始上传文件（保留）
      parsed.md           # 解析后的完整 markdown（带 YAML frontmatter）
      images/             # 提取的图片（如有）
    9de8ee9e/
      original.docx
      parsed.md
      images/
      parsed.json         # xlsx/csv 的解析结果（如有）
  agent-tutor/
    <docId[:8]>/
      ...
```

### 3.1 parsed.md 的 YAML frontmatter

```yaml
---
document_id: 87bfe9b9-5161-4fab-91f8-8f4abba89136
agent_id: agent-otcclaw
title: "2025年3月至2026年3月批量报价分析"
tags: 交易分析,定价,雪球
file_type: docx
created_by: user-simon
created_at: 2026-04-14T09:41:54
---

## 批量报价分析背景与目标

【时间段】：2025年3月至...
```

### 3.2 按 agent 组织的好处

- grep 搜索范围可限定到 `data/documents/<agent_id>/*/parsed.md`，**天然 agent 隩离**，无需后过滤
- 目录直观反映 agent 归属，便于人工浏览和管理
- 删除 agent 的所有文档只需清空对应子目录
- frontmatter 仍保留作元数据冗余（即使 DB 行丢失，文件仍可重建）

## 4. 搜索流程设计

`fetchKnowledge()` 改为双引擎：

### 4.1 DB 搜索（手动 FAQ）

保持现有加权 LIKE + CJK bigram 搜索，不变。

### 4.2 Grep 搜索（文档）

```
rg --json -C 3 <keywords> data/documents/<agent_id>/*/parsed.md
```

- 多关键词用 `|` 连接（regex OR）
- ripgrep 对 CJK 子串匹配原生支持，**无需 bigram 展开**
- Agent 隩离：由目录路径天然保证
- 评分算法：匹配关键词数量 × 权重（heading 行 2x，body 行 1x）
- 结果格式：`{ source: "document", document_id, title, snippet, relevance }`

### 4.3 合并排序

两路结果按 relevance 评分合并排序，返回 top 10。

### 4.4 tool description 变更

`search_knowledge` 工具描述改为：
- FAQ 搜索：建议用 2-4 字短关键词（现有指引保留）
- 文档搜索：接受自然短语（ripgrep 可直接匹配长中文串）

## 5. 导入流程变更

| 步骤 | 当前 | 新方案 |
|------|------|--------|
| 文件解析 | DOCX/PDF/XLSX → markdown | **保留** |
| LLM chunking | 拆分为 chunk + 生成 tags | 改为**只生成 tags**写入 frontmatter，不再拆分 |
| chunk → DB | 插入 knowledge + knowledge_agents | **删除** |
| 文件存储 | `data/documents/<docId[:8]>/` | 改为 `data/documents/<agent_id>/<docId[:8]>/` |
| parsed.md | 从 chunk 重建拼接 | 写入完整 markdown + YAML frontmatter |

关键函数改动：
- `getDocStorageDir()`：从 `data/documents/<docId[:8]>` 改为 `data/documents/<agent_id>/<docId[:8]>`
- `persistDocumentFiles()`：写入带 frontmatter 的 parsed 文件，保留 original 文件
- `loadAndChunk()`：返回完整 markdown + tags（LLM 只生成 tags 不拆分）
- `importDocument()`：删除 chunk → knowledge/knowledge_agents DB 插入循环
- `documents` 表 `stored_path` 更新为新路径

## 6. 实施步骤

### Step 1: 新建 grep 搜索模块

- **新建文件**：`src/utils/grep-search.ts`
- 封装 ripgrep 调用（`child_process.execFileSync('rg', ...)`）
- 解析 `--json` 输出（每行是一个 JSON 对象，包含 match 位置、文本）
- 提取 YAML frontmatter（用于获取 title、document_id 等元数据）
- 匹配计数评分：按文件聚合匹配数，heading 行（`#` 开头）权重 2x，body 行权重 1x
- 输出结构化结果数组

### Step 2: 修改 `fetchKnowledge()`

- **文件**：`src/commands/knowledge.ts`
- 改为调用 DB 搜索（手动 FAQ）+ grep 搜索（文档），合并排序
- 返回类型扩展为包含 `{ source: 'faq' | 'document', ... }`
- DB 搜索部分保持现有逻辑不变

### Step 3: 修改 `search_knowledge` 工具

- **文件**：`src/tools/knowledge-tools.ts`
- handler 适配新的双引擎结果格式
- FAQ 结果保持现有 snippet 提取逻辑
- 文档结果使用 grep `-C 3` 上下文行作为 snippet
- tool description 改为双模式指引

### Step 4: 修改导入流程

- **文件**：`src/commands/document-import.ts`
- `importDocument()` 删除 chunk → DB 插入循环（line 613-624 区域）
- `persistDocumentFiles()` 改为按 agent 维度存储 + 注入 frontmatter
- `getDocStorageDir(docId)` 改为 `getDocStorageDir(docId, agentId)`，路径含 agent_id
- `loadAndChunk()` 改为返回 `{ markdown: string, tags: string }` 而非 `Chunk[]`
- LLM chunking 逻辑保留但改为只输出 tags

### Step 5: DB migration + 文件迁移

- **文件**：`src/db/schema.ts`
- `runOnce('migrate-doc-knowledge-to-files', ...)`：
  1. 查询所有 `documents` 行，获取 agent_id 和 stored_path
  2. 将现有 `data/documents/<docId[:8]>/` 目录移到 `data/documents/<agent_id>/<docId[:8]>/`
  3. 读取每个 parsed.md，注入 YAML frontmatter，写回
  4. 更新 `documents` 表 `stored_path` 为新路径
  5. 删除 `knowledge` 表中 `document_id IS NOT NULL` 的行（CASCADE 自动清理 knowledge_agents）
  6. 清理失败导入目录（c1f08e98，仅有 images 无 original/parsed）

### Step 6: 更新 document-tools

- **文件**：`src/tools/document-tools.ts`
- `listDocuments()` 显示文件大小而非 chunk_count
- `deleteDocument()` 使用新的 `getDocStorageDir(docId, agentId)` 路径

## 7. 关键文件清单

| 文件 | 改动类型 | 核心改动 |
|------|----------|----------|
| `src/utils/grep-search.ts` | **新建** | ripgrep 封装、JSON 解析、frontmatter 提取、评分 |
| `src/commands/knowledge.ts` | 重写 | `fetchKnowledge()` 改为双引擎（DB + grep） |
| `src/tools/knowledge-tools.ts` | 修改 | handler 适配双引擎结果、tool description 双模式 |
| `src/commands/document-import.ts` | 重构 | 去掉 chunk→DB、改目录结构、注入 frontmatter |
| `src/db/schema.ts` | 新增 migration | 迁移文件目录 + 清理 knowledge 行 |
| `src/tools/document-tools.ts` | 小改 | 显示文件大小、使用新路径 |

## 8. 验证清单

| # | 验证项 | 预期结果 |
|---|--------|----------|
| 1 | Migration 后 `knowledge` 表 | 手动 FAQ 835 条不变，文档 chunk 23 条已删除 |
| 2 | 文件目录迁移 | `data/documents/87bfe9b9/` → `data/documents/agent-otcclaw/87bfe9b9/` |
| 3 | parsed.md frontmatter | 每个文件含 document_id, agent_id, title, tags, file_type, created_by, created_at |
| 4 | `search_knowledge` 结果 | 同时返回 FAQ + 文档两类结果 |
| 5 | Agent 隩离 | grep 搜索范围限定到 `data/documents/<agent_id>/`，其他 agent 的文档不可见 |
| 6 | CJK 搜索 | ripgrep 直接匹配"雪球产品"等中文短语，无需 bigram |
| 7 | 新导入文档 | 文件存到 `data/documents/<agent_id>/<docId>/`，只创建 documents 行，不创建 knowledge 行 |
| 8 | 删除文档 | documents 行 + 磁盘目录删除，无 orphan knowledge 行 |
| 9 | `/doc-list` | 按当前 agent 过滤，显示文件大小而非 chunk_count |
| 10 | 手动 FAQ CRUD | 添加/修改/删除手动 FAQ 不受影响 |

## 9. 风险与回退

- **ripgrep 不可用**：系统需确保 `rg` 已安装。可在 grep-search.ts 中加检测，fallback 到 Node.js 文件读取 + 正则匹配
- **migration 失败**：migration 是幂等的（`runOnce`），重启后不会重复执行。如需回退，手动将目录移回扁平结构 + 重新导入文档
- **Excel 文件（parsed.json）**：xlsx/csv 的解析结果是 JSON 格式而非 markdown。需在 `persistDocumentFiles()` 中统一转为 markdown 表格格式写入 parsed.md，或保留 parsed.json 并在 grep 搜索时也搜索 `.json` 文件

---

See also: [2026-04-20_documents-markdown-grep_review.md](./2026-04-20_documents-markdown-grep_review.md) — 对本计划的建设性评审与修订建议。