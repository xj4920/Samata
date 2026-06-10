# Otcclaw Agent 四大模块管理机制综述

## 概述

Otcclaw Agent（Samata 多 Agent 架构）通过四个核心模块实现知识的沉淀与复用：

| 模块 | 核心职责 | 数据隔离方式 |
|------|----------|--------------|
| **Memory** | 长期记忆存储，system prompt 注入 | scope 区分全局/agent 专属 |
| **Tools** | LLM 可调用的能力集合 | 三层过滤（Agent/User/Universal） |
| **Skills** | 可复用的 prompt 模板 | agent_id 直接关联，fallback 全局 |
| **Knowledge** | FAQ 问答知识库 + 文档知识库 | FAQ 多对多关联表；文档按 agent 目录隔离 + grep |

所有模块在 system prompt 构建时统一注入（`src/llm/agents/prompt.ts`），形成完整的 agent 能力上下文。

---

## 第一章 Memory 管理

### 1.1 设计理念

Memory 是 agent 的长期记忆存储，用于保存重要信息（用户偏好、项目背景、关键决策等），在每次对话时注入 system prompt，实现"记忆延续"。

### 1.2 数据库设计

```sql
CREATE TABLE memory (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT,                              -- NULL=全局，非NULL=agent专属
  scope      TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'agent')),
  content    TEXT NOT NULL,                     -- 记忆内容
  category   TEXT,                              -- 分类标签
  source     TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'auto')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
```

**关键设计**：
- `scope='global'`：全局记忆，所有 agent 可见，`agent_id` 为 NULL
- `scope='agent'`：agent 专属记忆，仅本 agent 可见，`agent_id` 必填
- `source='manual'`：用户手动添加；`source='auto'`：LLM 自动生成
- **容量限制**：每个 scope 最多 100 条，超出时按创建时间淘汰最旧的

### 1.3 核心实现

**文件位置**：`src/llm/agents/memory.ts`

| 函数 | 作用 |
|------|------|
| `fetchMemory(agentId?)` | 获取全局记忆 + agent 专属记忆 |
| `searchMemory(keyword, agentId?)` | 按关键词搜索记忆 |
| `saveMemory(input)` | 保存记忆，自动触发淘汰机制 |
| `updateMemory(idPrefix, updates)` | 更新指定记忆 |
| `deleteMemory(idPrefix)` | 删除记忆 |
| `buildMemoryBlock(agentId?)` | 构建 system prompt 中的 `{{memory}}` 块 |

**淘汰机制**（`saveMemory` 内部）：
```typescript
// 检查容量，超出时删除最旧的
const count = await db.get(`SELECT COUNT(*) FROM memory WHERE scope=? AND agent_id=?`);
if (count > 100) {
  await db.run(`DELETE FROM memory WHERE scope=? AND agent_id=? ORDER BY created_at LIMIT 1`);
}
```

### 1.4 工具定义

**文件位置**：`src/tools/memory-tools.ts`

| 工具名 | 功能 | 权限 |
|--------|------|------|
| `save_memory` | 保存记忆（可选 scope） | global: 系统管理员；agent: Agent管理员 |
| `search_memory` | 搜索记忆 | 所有用户 |
| `delete_memory` | 删除记忆 | global: 系统管理员；agent: Agent管理员 |

### 1.5 System Prompt 注入

在 `buildSystemPrompt()` 中调用 `buildMemoryBlock(agentId)`：

```typescript
// 构建记忆块
export function buildMemoryBlock(agentId?: string): string {
  const memories = await fetchMemory(agentId);
  if (memories.length === 0) return '';

  return `## 记忆\n以下是你应该记住的重要信息：\n${memories.map(m => `- ${m.content}`).join('\n')}`;
}
```

注入到模板的 `{{memory}}` 占位符。

---

## 第二章 Tools 管理

### 2.1 设计理念

Tools 是 LLM 可调用的能力集合。Otcclaw 采用**三层过滤机制**，在 Agent 配置、User 权限、Universal 工具三个层面控制工具可见性。

### 2.2 Agent 配置字段

```typescript
interface AgentConfig {
  // Agent 层配置
  toolsMode: 'all' | 'standard' | 'allowlist' | 'blocklist';
  toolsList: string[];      // standard 模式为 extra tools，allowlist/blocklist 为目标列表
  blockTools: string[];     // 要排除的工具（仅 all/standard 模式有效）

  // User 层配置（普通成员权限）
  userToolsMode: 'inherit' | 'all' | 'allowlist' | 'blocklist';
  userToolsList: string[];  // 普通成员的工具列表
}
```

### 2.3 COMMON_SET（标准工具集）

**文件位置**：`src/llm/agents/config.ts` 第13-32行

```typescript
export const COMMON_SET = new Set([
  // Knowledge 工具
  'search_knowledge', 'add_knowledge', 'update_knowledge', 'delete_knowledge', 'list_knowledge_recent',
  // Skills 工具
  'list_skills', 'get_skill', 'save_skill', 'delete_skill', 'run_skill',
  // 状态查询
  'get_status_summary',
  // Memory 工具
  'save_memory', 'search_memory', 'delete_memory',
  // Artifacts
  'write_artifact', 'send_file', 'send_image',
  // Reminders & Todos
  'set_reminder', 'list_reminders', 'cancel_reminder',
  'create_todo', 'list_todos', 'update_todo', 'delete_todo',
  // Media 生成
  'generate_image', 'generate_video',
  // Documents
  'import_document', 'list_documents', 'delete_document',
]);
```

### 2.4 三层过滤机制

**文件位置**：`src/llm/agents/config.ts` → `getAgentTools()` 函数

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Agent 层 - 根据 tools_mode 计算基础工具集          │
│ ├─ 'all':      全部工具 - blockTools                        │
│ ├─ 'standard': COMMON_SET + toolsList + pluginTools - blockTools │
│ ├─ 'allowlist': 仅 toolsList                                │
│ └─ 'blocklist': 全部工具 - toolsList                        │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: User 层 - 非管理员用户再次过滤                     │
│ ├─ userToolsMode='blocklist': 结果 - userToolsList          │
│ └─ userToolsMode='allowlist': 仅保留 userToolsList          │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: Universal 层 - 始终可用                            │
│ └─ http_request 等工具强制加入                              │
└─────────────────────────────────────────────────────────────┘
```

**核心逻辑**：
```typescript
export function getAgentTools(agent: AgentConfig, globalTools: Tool[], isAdmin = true): Tool[] {
  let effectiveNames: Set<string>;

  // Layer 1: Agent 层
  if (agent.toolsMode === 'all') {
    effectiveNames = new Set(globalTools.map(t => t.name));
    for (const b of agent.blockTools) effectiveNames.delete(b);
  } else if (agent.toolsMode === 'standard') {
    effectiveNames = new Set([...COMMON_SET, ...agent.toolsList, ...pluginToolNames]);
    for (const b of agent.blockTools) effectiveNames.delete(b);
  } // ... allowlist/blocklist 处理

  // Layer 2: User 层
  if (!isAdmin) {
    if (agent.userToolsMode === 'blocklist') {
      for (const b of agent.userToolsList) effectiveNames.delete(b);
    }
  }

  // Layer 3: Universal 层
  for (const u of UNIVERSAL_TOOLS) effectiveNames.add(u);

  return globalTools.filter(t => effectiveNames.has(t.name));
}
```

### 2.5 工具定义来源

**文件位置**：`src/tools/` 目录

| 来源 | 函数 | 说明 |
|------|------|------|
| Native 工具 | `getAllNativeTools()` | `src/tools/index.ts` 汇总各模块工具 |
| Plugin 工具 | `getPluginTools()` | `plugins/<name>/index.ts` 动态加载 |
| MCP 工具 | `getMcpTools()` | 外部 MCP server 提供的工具 |

### 2.6 新增 Tool 必走 Checklist

1. **定位业务归属**：
   - 通用只读类 → 加入 `COMMON_SET`
   - Agent 专属 → 通过 migration 补进 `tools_list`

2. **区分读写性质**：
   - 写操作（add/update/delete/import）→ **必须**进 `user_tools_list` blocklist
   - 破坏性操作（exec_cmd、reload_app）→ 仅系统管理员可用

3. **加 migration**：在 `src/db/schema.ts` 末尾新增 `runOnce()` 幂等更新

4. **验证**：重启后 SQL 确认 + admin/普通成员各测一次

---

## 第三章 Skills 管理

### 3.1 设计理念

Skills 是可复用的 prompt 模板，用于封装常用任务（如"总结会议纪要"、"生成周报"）。用户通过 `run_skill` 调用，LLM 将模板中的 `{param}` 占位符替换为实际参数。

### 3.2 数据库设计

```sql
CREATE TABLE skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,                    -- skill 名称（调用时使用）
  prompt      TEXT NOT NULL,                    -- prompt 模板，支持 {param} 占位符
  description TEXT,                             -- 描述（list_skills 时展示）
  agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,  -- NULL=全局
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX skills_name_agent_unique ON skills(name, COALESCE(agent_id, ''));
```

**关键设计**：
- `agent_id` 为 NULL：全局 skill，所有 agent 可用
- `agent_id` 非 NULL：agent 专属 skill
- 唯一索引基于 `(name, agent_id)`，允许同名 skill 存在于不同 agent

### 3.3 核心实现

**文件位置**：`src/commands/skill.ts`

| 函数 | 作用 |
|------|------|
| `getAllSkills(agentId?)` | 查询所有 skill，支持按 agent 过滤 |
| `getSkillByName(name, agentId)` | 查询时优先 agent 专属，fallback 全局 |
| `saveSkill(name, prompt, agentId?, description?)` | 创建/更新 skill |
| `deleteSkill(name, agentId)` | 删除 skill |

**查询优先级**（`getSkillByName`）：
```typescript
// 优先查找 agent 专属
const agentSkill = await db.get(`SELECT * FROM skills WHERE name=? AND agent_id=?`, name, agentId);
if (agentSkill) return agentSkill;

// Fallback 到全局
return await db.get(`SELECT * FROM skills WHERE name=? AND agent_id IS NULL`, name);
```

### 3.4 工具定义

**文件位置**：`src/tools/skill-tools.ts`

| 工具名 | 功能 | 权限 |
|--------|------|------|
| `list_skills` | 列出可用 skill（DB + plugin） | 所有用户 |
| `get_skill` | 获取 skill 完整内容 | 所有用户 |
| `save_skill` | 创建/更新 skill（支持 scope 参数） | global: 系统管理员；agent: Agent管理员 |
| `delete_skill` | 删除 skill | global: 系统管理员；agent: Agent管理员 |
| `run_skill` | 执行 skill，替换 `{param}` 占位符 | 所有用户 |

**run_skill 执行逻辑**：
```typescript
// 获取 skill 模板
const skill = await getSkillByName(name, getCurrentAgent()?.id);

// 替换占位符
let prompt = skill.prompt;
for (const [key, value] of Object.entries(params)) {
  prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
}

// 发送给 LLM
return await runAgenticChat(history, prompt, user);
```

### 3.5 System Prompt 注入

在 `buildSystemPrompt()` 中调用 `buildSkillsBlock(agentId)`：

```typescript
export function buildSkillsBlock(agentId?: string): string {
  const skills = await getAllSkills(agentId);
  if (skills.length === 0) return '';

  return `## 可用 Skills\n以下是可以直接调用的技能模板：\n${skills.map(s =>
    `- **${s.name}**: ${s.description || '无描述'}`
  ).join('\n')}`;
}
```

注入到模板的 `{{skills}}` 占位符。

---

## 第四章 Knowledge 管理

### 4.1 设计理念

Knowledge 采用**双引擎混合架构**：手动 FAQ 存 DB（CRUD 频繁，适合关系查询），文档知识存磁盘 Markdown 文件（长文本、导入后只读，适合 grep 搜索）。`search_knowledge` 一次调用同时跑两路引擎，返回结构化双分组 `{ faq, documents }`，不做分数混排。

两类数据的本质差异：
- **手动 FAQ**：结构化 Q&A，CRUD 频繁，多 agent 可共享一条 → 适合 DB + 多对多关联表
- **文档知识**：长文本，导入后只读，按 agent 目录隔离 → 适合文件存储 + ripgrep 搜索

### 4.2 数据库设计（手动 FAQ 部分）

```sql
-- 知识条目表（仅存手动 FAQ）
CREATE TABLE knowledge (
  id           TEXT PRIMARY KEY,
  question     TEXT NOT NULL,                   -- 问题（唯一）
  answer       TEXT NOT NULL,                   -- 答案
  tags         TEXT,                            -- 标签（逗号分隔）
  related_users TEXT,                           -- 相关用户
  document_id  TEXT REFERENCES documents(id) ON DELETE CASCADE,  -- 退役：migration 后所有行此列为 NULL
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_knowledge_question ON knowledge(question);

-- 多对多关联表
CREATE TABLE knowledge_agents (
  id           TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE(knowledge_id, agent_id)
);
```

**关键设计**：
- `knowledge_agents` 关联表实现多对多——一条 FAQ 可关联多个 agent（如"公司介绍"可同时用于 otcclaw 和 ticlaw）
- `document_id` 列为**退役字段**：migration 后所有 `document_id IS NOT NULL` 的行已删除，仅手动 FAQ（`document_id IS NULL`）保留
- 唯一索引确保 question 不重复

### 4.3 核心实现

**文件位置**：`src/commands/knowledge.ts`（FAQ）、`src/utils/grep-search.ts`（文档 grep）

| 函数 | 作用 |
|------|------|
| `fetchKnowledge(keyword?, agentId?)` | 返回 `{ faq: KnowledgeItem[], documents: GrepDocResult[] }` 双分组 |
| `addKnowledge(fields, agentId?)` | 新增 FAQ 条目并自动关联到 agent |
| `updateKnowledgeById(idPrefix, fields, agentId?)` | 更新 FAQ 条目 |
| `deleteKnowledge(idPrefix, agentId?)` | 删除 FAQ 条目 |
| `assignKnowledgeToAgent(knowledgeId, agentId)` | 关联 FAQ 到 agent |
| `unassignKnowledgeFromAgent(knowledgeId, agentId)` | 解除 FAQ 关联 |

**FAQ 搜索逻辑**（DB 加权 LIKE + CJK bigram）：
```typescript
// 多关键词搜索 + CJK bigram 拆分
const keywords = keyword.split(/\s+/);
const conditions = keywords.map(k => {
  if (/[\u4e00-\u9fff]/.test(k)) {
    const bigrams = [...k].slice(0, -1).map((c, i) => k.slice(i, i+2));
    return bigrams.map(b => `question LIKE '%${b}%'`).join(' AND ');
  }
  return `question LIKE '%${k}%' OR answer LIKE '%${k}%'`;
});

// JOIN 关联表过滤 agent（仅查手动 FAQ：document_id IS NULL）
const sql = `
  SELECT k.* FROM knowledge k
  JOIN knowledge_agents ka ON k.id = ka.knowledge_id
  WHERE ka.agent_id = ? AND k.document_id IS NULL AND (${conditions.join(' OR ')})
`;
```

**文档搜索逻辑**（ripgrep）：
```typescript
// src/utils/grep-search.ts
// rg -F -i --json --glob '**/parsed.md' -e kw1 -e kw2 data/documents/<agentId>/
// 解析 --json 输出 → frontmatter 过滤 → 加权评分 → top 5 文档结果
// 权重：title×3 / tags×2 / heading×2 / body×1（与 FAQ 同构）
// 大类词降权（BROAD_BUSINESS_TERMS）
```

### 4.4 工具定义

**文件位置**：`src/tools/knowledge-tools.ts`

| 工具名 | 功能 | 权限 |
|--------|------|------|
| `search_knowledge` | 同时搜索 FAQ + 文档，返回双分组 `{ faq, documents }` | 所有用户 |
| `add_knowledge` | 新增 FAQ 并关联当前 agent | Agent管理员 |
| `update_knowledge` | 更新 FAQ | Agent管理员 |
| `delete_knowledge` | 删除 FAQ | Agent管理员 |
| `assign_knowledge_agent` | 关联 FAQ 到 agent | 仅系统管理员 |
| `unassign_knowledge_agent` | 解除 FAQ 关联 | 仅系统管理员 |
| `get_knowledge_agents` | 查询 FAQ 关联的 agent 列表 | 所有用户 |
| `list_knowledge_recent` | 按更新时间查询 FAQ | 所有用户 |

**`search_knowledge` 返回格式**：
```json
{
  "faq": [ { "id", "question", "answer", "tags", "relevance" } ],      // top 10
  "documents": [ { "document_id", "title", "tags", "matches": [ { "line", "snippet", "weight" } ], "relevance" } ]  // top 5
}
```

- tool description 简化为"自动双查 FAQ 与文档，建议用自然关键词"，不再要求 LLM 决策查询策略
- FAQ 排名由 DB 加权 LIKE + bigram 评分决定；文档排名由 grep 加权评分决定，两路分数量纲不同，不做混排

### 4.5 agent_id 关联机制（FAQ 多对多 vs 文档目录隔离）

**手动 FAQ** 采用**多对多关联表**（与 Skills/Memory 不同）：

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│ knowledge   │     │ knowledge_agents │     │ agents      │
│-------------│     │------------------│     │-------------│
│ id          │◄────│ knowledge_id     │     │ id          │
│ question    │     │ agent_id         │◄────│ name        │
│ answer      │     │ UNIQUE(k_id,a_id)│     │ ...         │
└─────────────┘     └──────────────────┘     └─────────────┘
```

- 一条 FAQ 可复用于多个 agent
- 删除 agent 时自动解除关联（ON DELETE CASCADE）
- FAQ 本身独立存在，不依赖特定 agent

**文档知识** 采用**按 agent 目录隔离**：

```
data/documents/
  agent-otcclaw/
    87bfe9b9/
      original.docx      # 原始上传文件
      parsed.md           # 带 YAML frontmatter 的完整 markdown
      images/             # 提取的图片（如有）
    9de8ee9e/
      original.docx
      parsed.md
  agent-ticlaw/
    <docId[:8]>/
      ...
```

- 目录路径天然保证 agent 隔离，grep 搜索范围限定到 `data/documents/<agent_id>/`
- 文档**放弃多 agent 共享**，一个文档只归属一个 agent
- frontmatter 保留元数据冗余（即使 DB 行丢失，文件仍可重建）

**parsed.md YAML frontmatter**：
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
...
```

### 4.6 Document Import — 文档导入为 Markdown 文件 + Grep 搜索

Knowledge 有两大来源：手动 `add_knowledge`（单条 FAQ → DB）和 `import_document`（文档 → Markdown 文件 + frontmatter → grep 搜索）。文档不再拆分为 chunk 存入 `knowledge` 表。

#### 支持的文件类型

| 格式 | 解析方式 | 输出 |
|------|----------|------|
| `.md` | 直接读取文本 | 带 frontmatter 的完整 markdown |
| `.docx` | `parse_word` 插件（Pandoc/mammoth）→ Markdown | 带 frontmatter 的完整 markdown |
| `.xlsx` / `.csv` | 内建 `splitExcelBySheets`（XLSX 库）→ Markdown 表格 | 每个 Sheet 一个 `## {docTitle} - {sheetName}` 段，统一写入 parsed.md |
| `.pdf` | `parse_pdf` 插件（Marker/pdf-parse）→ Markdown | 带 frontmatter 的完整 markdown |

#### documents 表结构

```sql
CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,                   -- 文档标题
  source_path TEXT NOT NULL,                   -- 原始文件路径
  file_type   TEXT NOT NULL,                   -- 文件类型 (md/docx/xlsx/csv/pdf)
  chunk_count INTEGER NOT NULL DEFAULT 0,      -- 退役字段，不再维护（保持旧值或写 0）
  size_bytes  INTEGER,                         -- 文件大小（parsed.md 的字节大小）
  agent_id    TEXT REFERENCES agents(id),      -- 所属 Agent（唯一归属，不可共享）
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  stored_path TEXT                             -- 存储目录路径：data/documents/<agent_id>/<docId[:8]>/
);
```

**关键变化**：
- `chunk_count` 退役为历史字段（不再维护）
- 新增 `size_bytes` 列（`ALTER TABLE documents ADD COLUMN size_bytes INTEGER`），显示文件大小而非 chunk 数
- `agent_id` 为唯一归属——文档**不可多 agent 共享**，一个文档只属于一个 agent
- `stored_path` 改为 `data/documents/<agent_id>/<docId[:8]>/`（含 agent_id 路径）

#### 导入流程

```
import_document(file_path, title?)
  │
  ├─ 1. 权限检查: ensureDocWriteAccess(agentId) — 需要 Agent admin
  ├─ 2. 文件路径解析 & 类型检测
  ├─ 3. 重复导入检查 (source_path + agent_id)
  ├─ 4. 生成 docId (UUID)
  │
  ├─ 5. loadAndChunk() — 按文件类型分支解析（不再拆分 chunk，只生成 tags）:
  │   ├─ .md    → 读取 → splitMarkdownByHeadings → LLM 只生成 tags
  │   ├─ .docx  → parse_word → 图片描述(Vision) → LLM 只生成 tags
  │   ├─ .xlsx  → splitExcelBySheets → 每个 Sheet 转 Markdown 表格
  │   ├─ .csv   → splitExcelBySheets
  │   ├─ .pdf   → parse_pdf → 图片描述(Vision) → LLM 只生成 tags
  │   → 返回 { markdown: string, tags: string[] }
  │
  ├─ 6. persistDocumentFiles() — 存储到 data/documents/<agentId>/<docId[:8]>/
  │   ├─ original.{ext}  — 原始文件副本
  │   ├─ parsed.md       — 完整 markdown + YAML frontmatter（含 document_id, agent_id, title, tags, file_type, created_by, created_at）
  │   ├─ parsed.json     — Excel/CSV 结构化备份（保留但不参与 grep）
  │   └─ images/         — 提取的图片（Word/PDF）
  │
  ├─ 7. INSERT documents 表（含 size_bytes）
  │     ❌ 不再: INSERT knowledge + INSERT knowledge_agents
  └─ 8. 返回 { success, documentId, title, sizeBytes, topics }
```

#### 与手动 add_knowledge 的区别

| 维度 | import_document | add_knowledge |
|------|----------------|---------------|
| 来源 | 文件自动解析 | 手动输入 |
| 存储位置 | 磁盘 parsed.md + frontmatter | DB knowledge 表 |
| 搜索方式 | ripgrep（自然短语匹配） | DB LIKE + CJK bigram |
| agent 隩离 | 目录路径天然隔离 | knowledge_agents 多对多 |
| 删除方式 | `delete_document` 删除 documents 行 + 磁盘目录 | `delete_knowledge` 逐条删除 |
| 权限 | Agent admin（在 user blocklist 中） | Agent admin |
| 多 agent 共享 | ❌ 不支持（一个文档只归属一个 agent） | ✅ 支持（一条 FAQ 可关联多个 agent） |

System prompt 中明确路由规则：
> 用户要求将文件保存/导入为知识时，**必须使用 import_document**；**禁止将整个文件内容用 add_knowledge 保存为单条知识**

#### Document 工具定义

**文件位置**：`src/tools/document-tools.ts`

| 工具名 | 功能 | 权限 |
|--------|------|------|
| `import_document` | 将文件导入为 Markdown 文件（不再分块存 DB） | Agent admin（在 user blocklist 中） |
| `list_documents` | 列出当前 Agent 已导入文档（显示 size_bytes） | 所有用户 |
| `delete_document` | 删除 documents 行 + 磁盘目录（不再级联删 knowledge 行） | Agent admin |

#### Grep 搜索模块

**文件位置**：`src/utils/grep-search.ts`

| 函数 | 作用 |
|------|------|
| `searchDocumentsByGrep(keyword, agentId)` | ripgrep 搜索 `data/documents/<agentId>/*/parsed.md`，返回加权评分 top 5 |

**ripgrep 调用规范**：
- `execFileSync('rg', args)` — args 为字符串数组，永不拼 shell
- `-F` fixed-string 模式（关键词当字面量，避免正则歧义）
- 多关键词用 `-e kw1 -e kw2 ...`（ripgrep OR），不走 `|` 正则
- `--glob '**/parsed.md'` 限定搜索范围，排除 parsed.json
- `-i` case-insensitive（英文；CJK 天然无大小写）
- `--json` 输出逐行 JSON 解析

**加权评分**（与 FAQ 同构）：

| 命中位置 | 对应 FAQ 字段 | 权重 |
|----------|---------------|------|
| frontmatter `title` | question | 3 |
| frontmatter `tags` | tags | 2 |
| markdown heading 行（`#/##/###`） | question | 2 |
| body 行 | answer | 1 |
| frontmatter 元数据（`document_id`/`created_at`/`created_by`/`file_type`/`agent_id`） | 无 | **丢弃** |

大类词降权（复刻 `BROAD_BUSINESS_TERMS` 规则）。

**Frontmatter 污染过滤**：grep-search 侧做后处理——定位 match line 是否落在 `---` 围栏区间内，元数据命中丢弃，title/tags 命中按高权计分。

**Fallback**：rg 不存在时用 Node `fs.readFileSync` + `String.includes` 逐文件扫描。

---

## 总结

### 数据隔离方式对比

| 模块 | 关联方式 | 全局数据 | 专属数据 | 查询机制 |
|------|----------|----------|----------|----------|
| **Memory** | `agent_id + scope` | scope='global', agent_id=NULL | scope='agent', agent_id=必填 | 合并全局 + 专属 |
| **Tools** | 配置字段过滤 | COMMON_SET | tools_list + user_tools_list | `getAgentTools()` 三层过滤 |
| **Skills** | `agent_id` 直接关联 | agent_id=NULL | agent_id=必填 | 优先专属，fallback 全局 |
| **Knowledge** | FAQ 多对多关联表；文档按 agent 目录隔离 | FAQ 可关联多个 agent；文档不可共享 | FAQ 通过 knowledge_agents 关联；文档通过目录路径隔离 | FAQ: DB LIKE + bigram；文档: ripgrep 加权搜索 |

### 权限层级统一模型

```
系统管理员 (isSystemAdmin)
  = channel==='cli' AND role==='admin'
  ├─ 全局数据完全控制（global memory/skill/knowledge）
  ├─ 所有 agent 配置修改
  └─ 破坏性工具（exec_cmd、reload_app）

Agent 管理员 (isAgentAdmin(agentId))
  = isSystemAdmin OR agent_members.role='admin'
  ├─ Agent 专属数据（agent memory/skill/knowledge）
  ├─ Agent 配置（model、tools_list 等）
  └─ 自举工具（save_skill、delete_skill）

普通用户
  └─ 只读查询 + 受 user_tools_list 限制的写操作
```

### System Prompt 构建流程

```typescript
// src/llm/agents/prompt.ts
export function buildSystemPrompt(agent: AgentConfig, user?: User): string {
  const template = loadPromptTemplate(agent.name);  // config/agents/<name>.md

  return renderPrompt(template, {
    permissions: buildPermissionText(user, agent),
    attachments: ATTACHMENT_GUIDANCE,
    skills: buildSkillsBlock(agent.id),      // Skills 注入
    memory: buildMemoryBlock(agent.id),      // Memory 注入
  });
}
```

**模板占位符**（`config/agents/<name>.md`）：
```
{{agent.displayName}} / {{agent.description}}  — agent 元数据
{{permissions}}                                — 用户权限说明
{{attachments}}                                — 附件发送规范
{{skills}}                                     — 可用 skills 列表
{{memory}}                                     — 记忆块
```

### 关键文件路径

| 功能 | 文件路径 |
|------|----------|
| 数据库 Schema | `src/db/schema.ts` |
| Memory 实现 | `src/llm/agents/memory.ts` |
| Memory 工具 | `src/tools/memory-tools.ts` |
| Agent 配置 | `src/llm/agents/config.ts` |
| 工具汇总 | `src/tools/index.ts` |
| Skills 命令 | `src/commands/skill.ts` |
| Skills 工具 | `src/tools/skill-tools.ts` |
| Knowledge 命令 | `src/commands/knowledge.ts` |
| Knowledge 工具 | `src/tools/knowledge-tools.ts` |
| Document 导入 | `src/commands/document-import.ts` |
| Document 工具 | `src/tools/document-tools.ts` |
| Grep 搜索模块 | `src/utils/grep-search.ts` |
| Word 解析插件 | `plugins/word-parser/index.ts` |
| PDF 解析插件 | `plugins/pdf-parser/index.ts` |
| Prompt 构建 | `src/llm/agents/prompt.ts` |
| Agent 运行时 | `src/llm/agent.ts` |
