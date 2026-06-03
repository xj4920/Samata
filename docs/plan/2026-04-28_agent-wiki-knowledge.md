# Agent Wiki 知识库改造计划

参考 Karpathy LLM Wiki 思路，将知识主体从平铺 FAQ 表升级为 Agent 级结构化 Wiki 目录。

## 架构变更

```
当前：
  data/documents/<agent>/     ← 原始文档堆积
  knowledge 表                 ← 唯一的知识检索入口（平铺 FAQ，按 agent 过滤）

目标：
  data/documents/<agent>/     ← 保留，原始用户上传资料（只读，事实来源）
  data/wiki/<agent>/          ← 新增，Agent 级 Wiki（结构化 Markdown，LLM 维护）
  ├── index.md               ← 总索引（LLM 维护）
  ├── concepts/              ← 概念页（FIX Protocol、算法单、券池...）
  ├── entities/              ← 实体页（客户、产品、对接系统...）
  └── CHANGELOG.md           ← 变更日志
  knowledge 表 (FTS5)         ← 快速补充索引（FAQ 问答对，指向 wiki 页面）
```

## 组件职责重新划分

| 组件 | 定位 | 职责 |
|---|---|---|
| `data/wiki/<agent>/` | 新增，知识主体 | 结构化 Markdown，LLM 阅读+维护，有关联和上下文 |
| `knowledge` 表 (FTS5) | 快速索引层 | FAQ 问答对，FTS5 快速命中，指向 wiki 页面 |
| `data/documents/<agent>/` | 保留不变 | 原始用户上传资料（只读，事实来源） |
| Workspace | 不变 | 会话摘要 + 用户偏好 |

## 三种核心操作

### 1. Ingest（文档上传 → Wiki 生成）

用户上传文档后，走流水线（升级 `import_document`）：

```
import_document
  → 原始文件存入 data/documents/<agent>/（保持不变，只读事实来源）
  → LLM 阅读文档，拆解出：
      - 新增/更新概念页（concepts/*.md）
      - 新增/更新实体页（entities/*.md）
      - 更新 index.md 索引
      - 追加 CHANGELOG.md
  → 人工 review wiki diff，确认或修正
```

一篇 FIX 对接文档 → 自动产出：FIX 概念页更新 + 客户实体页更新 + 索引更新。

### 2. Query（查询优先级）

```
用户提问
  → LLM 先看 wiki/index.md，定位相关概念/实体页
  → 读取 wiki 页面全文（结构化知识，有完整上下文）
  → 不足时 FTS5 搜 FAQ（knowledge 表）做快速补充
  → 仍不足时可读 data/documents/<agent>/ 原始文档
  → 回答后，若用户反馈 good/有用，LLM 将该 Q&A 写入 knowledge 表（带 wiki_ref 指向相关页面）
```

FAQ 不随文档导入自动生成，而是由**用户反馈驱动**：只有当用户提问并确认回答有用时，才将问答对写入 knowledge 表。Wiki 页面提供深度、结构化、带交叉引用的完整信息，FAQ 作为高频问答的快速命中缓存。

### 3. Lint（健康巡检）

新增 `lint_wiki` 工具，定期检查：

- wiki 页面之间的**矛盾**（同一概念不同页面有不同描述）
- **孤立页面**（没有被 index.md 引用的页面）
- **过时信息**（超过 N 天未更新，需要 review）
- FAQ 与 wiki 的**不一致**（FAQ 有但 wiki 没覆盖 → 补 wiki；wiki 已更新但 FAQ 过期 → 标 stale）
- 高频 query 但命中率为 0 的**知识盲区** → 生成待补充列表

## 数据库变更

knowledge 表新增字段：

```sql
ALTER TABLE knowledge ADD COLUMN wiki_ref TEXT;  -- 指向 wiki 页面路径，如 "concepts/fix-protocol.md"
```

FAQ 与 wiki 的关系：FAQ 是 wiki 的快速入口，`wiki_ref` 指向完整上下文。

## 工具变更

### 新增工具

| 工具 | 说明 |
|---|---|
| `read_wiki_page` | 读取指定 wiki 页面内容（参 path 或 index.md 入口） |
| `write_wiki_page` | 写入/更新 wiki 页面（Agent admin 权限） |
| `list_wiki_pages` | 列出 wiki 目录结构 |
| `lint_wiki` | 健康巡检：矛盾检测、孤立页面、过时标记、盲区发现 |

### 升级工具

| 工具 | 变更 |
|---|---|
| `import_document` | 从单纯存文件升级为 trigger Ingest 流水线（存 documents/ → LLM 拆解 → 写 wiki） |
| `search_knowledge` | 优先读 wiki index → 查 wiki 页面 → FAQ 兜底 |

### 不变工具

| 工具 | 说明 |
|---|---|
| `add_knowledge` | 保留，有权限用户可手动插入 FAQ；同时 LLM 在用户确认回答有用后也会调用它写入 FAQ（带 wiki_ref） |
| `update_knowledge` | 保留 |
| `delete_knowledge` | 保留 |

## 关键文件

### 需要新建
- `src/commands/wiki.ts` — wiki 读写、Ingest 流水线、Lint 逻辑
- `src/tools/wiki-tools.ts` — LLM tool 定义和 handler

### 需要修改
- `src/db/schema.ts` — knowledge 表加 `wiki_ref` 字段（migration）
- `src/commands/document-import.ts` — `importDocument` 升级为 Ingest 流水线
- `src/commands/knowledge.ts` — `fetchKnowledge` 改为 wiki 优先查询
- `src/tools/document-tools.ts` — `import_document` 工具描述更新
- `src/llm/agents/prompt.ts` — system prompt 注入 wiki 可用工具引导
- `config/agents/otcclaw.md` — agent prompt 增加 wiki 使用说明

## 实施步骤

### Phase 1: 基础设施
1. 创建 `data/wiki/<agent>/` 目录结构模板
2. knowledge 表加 `wiki_ref` 字段（migration）
3. 实现 wiki 文件读写工具（`read_wiki_page`、`write_wiki_page`、`list_wiki_pages`）
4. 注册 tool definitions 并加入 agent tools_list

### Phase 2: Ingest 流水线
5. 升级 `import_document`：存 documents/ + LLM 拆解 + 写 wiki（不含 FAQ）
6. 实现 LLM 驱动的文档拆解 prompt（识别概念、实体，生成 wiki 页面）
7. 更新 index.md、CHANGELOG.md 的自动维护逻辑

### Phase 3: Query 升级
8. 改造 `fetchKnowledge` 查询流程：wiki 优先 → FAQ 补充
9. system prompt 中引导 LLM 先读 wiki index 再搜 FAQ

### Phase 4: Lint 巡检
10. 实现 `lint_wiki` tool：矛盾检测、孤立页面、过时标记、盲区发现

### Phase 5: 存量初始化
11. 一次性脚本：存量 `data/documents/<agent>/` 的文档 → 批量 Ingest 生成初始 wiki 页面

## 验证

1. 上传一篇 FIX 文档 → 确认 wiki 页面自动生成（概念页 + 实体页 + index 更新），不产生 FAQ
2. LLM 问答 → 确认优先使用 wiki 页面内容，FTS5 FAQ 做补充
3. `lint_wiki` → 确认能检测到孤立页面和矛盾信息
4. 存量文档迁移 → 确认 raw/ 归档完整，wiki 页面可读
