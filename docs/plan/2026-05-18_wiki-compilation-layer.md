# Wiki 编译层

## 背景

参考 Karpathy LLM Wiki 方法论，在 Samata 知识库中实现核心缺失层——Wiki 编译层。

传统 RAG 每次查询从零推导知识；Wiki 层在导入时"编译"知识（提取实体/概念/摘要），形成持久化的综合知识网络，查询时直接使用已编译结果。

## 架构

三层结构：
1. **Raw Sources** — `data/documents/<agent>/*/parsed.md`（已有）
2. **Wiki Layer** — `data/wiki/<agent>/`（新增）
3. **Schema** — `CLAUDE.md` + `config/agents/<name>.md`（已有）

Wiki 目录结构：
```
data/wiki/<agent>/
├── index.md          # 分类目录
├── log.md            # 操作时间线
├── entities/         # 实体页（人/机构/产品）
├── concepts/         # 概念页（规则/流程/指标）
├── summaries/        # 文档摘要
└── insights/         # 对话洞察
```

## 实现

### 两条知识沉淀路径

1. **导入时编译**（`src/services/wiki-compile.ts`）
   - `importDocument` 成功后异步触发
   - LLM 提取实体/概念/摘要，写入 wiki 目录
   - 自动维护 index.md 和 log.md

2. **提问时回填**（`src/tools/wiki-tools.ts` → `file_to_wiki`）
   - Agent 在对话中发现跨文档关联时主动调用
   - 通过 system prompt 引导 LLM 判断时机

### 搜索集成

`search_knowledge` 现返回三组结果：`{ wiki, faq, documents }`

Wiki 搜索复用已有的 ripgrep + zone scoring 机制（`grepSearchWiki` in `grep-search.ts`）。

## 修改文件清单

| 文件 | 变更 |
|------|------|
| `src/services/wiki-compile.ts` | 新建 |
| `src/tools/wiki-tools.ts` | 新建 |
| `src/commands/document-import.ts` | 导入后触发编译 |
| `src/utils/grep-search.ts` | 新增 `grepSearchWiki()` |
| `src/commands/knowledge.ts` | 搜索加入 wiki 源 |
| `src/tools/knowledge-tools.ts` | 返回结构增加 wiki |
| `src/tools/index.ts` | 注册 wikiTools |
| `src/llm/agents/prompt.ts` | 新增 wiki_guidance |
| `config/agents/_default.md` | 添加占位符 |
