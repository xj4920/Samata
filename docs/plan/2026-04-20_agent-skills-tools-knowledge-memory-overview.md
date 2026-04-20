# Otcclaw Agent 四大模块管理机制综述

## 概述

Otcclaw Agent（Samata 多 Agent 架构）通过四个核心模块实现知识的沉淀与复用：

| 模块 | 核心职责 | 数据隔离方式 |
|------|----------|--------------|
| **Memory** | 长期记忆存储，system prompt 注入 | scope 区分全局/agent 专属 |
| **Tools** | LLM 可调用的能力集合 | 三层过滤（Agent/User/Universal） |
| **Skills** | 可复用的 prompt 模板 | agent_id 直接关联，fallback 全局 |
| **Knowledge** | FAQ 问答知识库 | 多对多关联表 |

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

Knowledge 是 FAQ 问答知识库，用于存储问答对（question + answer）。支持多关键词搜索、CJK bigram 拆分优化，一条知识可关联多个 agent。

### 4.2 数据库设计

```sql
-- 知识条目表
CREATE TABLE knowledge (
  id           TEXT PRIMARY KEY,
  question     TEXT NOT NULL,                   -- 问题（唯一）
  answer       TEXT NOT NULL,                   -- 答案
  tags         TEXT,                            -- 标签（逗号分隔）
  related_users TEXT,                           -- 相关用户
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
- `knowledge_agents` 关联表实现多对多
- 一条 knowledge 可关联多个 agent（如"公司介绍"可同时用于 otcclaw 和 tutor）
- 唯一索引确保 question 不重复

### 4.3 核心实现

**文件位置**：`src/commands/knowledge.ts`

| 函数 | 作用 |
|------|------|
| `fetchKnowledge(keyword?, agentId?)` | 搜索知识，按 agent 过滤 |
| `addKnowledge(fields, agentId?)` | 新增条目并自动关联到 agent |
| `updateKnowledgeById(idPrefix, fields, agentId?)` | 更新条目 |
| `deleteKnowledge(idPrefix, agentId?)` | 删除条目 |
| `assignKnowledgeToAgent(knowledgeId, agentId)` | 关联知识到 agent |
| `unassignKnowledgeFromAgent(knowledgeId, agentId)` | 解除关联 |

**搜索逻辑**（`fetchKnowledge`）：
```typescript
// 多关键词搜索 + CJK bigram 拆分
const keywords = keyword.split(/\s+/);
const conditions = keywords.map(k => {
  // CJK 字符拆分为双字组合，提升中文搜索精度
  if (/[\u4e00-\u9fff]/.test(k)) {
    const bigrams = [...k].slice(0, -1).map((c, i) => k.slice(i, i+2));
    return bigrams.map(b => `question LIKE '%${b}%'`).join(' AND ');
  }
  return `question LIKE '%${k}%' OR answer LIKE '%${k}%'`;
});

// JOIN 关联表过滤 agent
const sql = `
  SELECT k.* FROM knowledge k
  JOIN knowledge_agents ka ON k.id = ka.knowledge_id
  WHERE ka.agent_id = ? AND (${conditions.join(' OR ')})
`;
```

### 4.4 工具定义

**文件位置**：`src/tools/knowledge-tools.ts`

| 工具名 | 功能 | 权限 |
|--------|------|------|
| `search_knowledge` | 搜索 FAQ（多关键词 + CJK bigram） | 所有用户 |
| `add_knowledge` | 新增 FAQ 并关联当前 agent | Agent管理员 |
| `update_knowledge` | 更新 FAQ | Agent管理员 |
| `delete_knowledge` | 删除 FAQ | Agent管理员 |
| `assign_knowledge_agent` | 关联知识到 agent | 仅系统管理员 |
| `unassign_knowledge_agent` | 解除关联 | 仅系统管理员 |
| `get_knowledge_agents` | 查询知识关联的 agent 列表 | 所有用户 |
| `list_knowledge_recent` | 按更新时间查询 | 所有用户 |

### 4.5 agent_id 关联机制

与 Skills/Memory 不同，Knowledge 采用**多对多关联表**：

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│ knowledge   │     │ knowledge_agents │     │ agents      │
│-------------│     │------------------│     │-------------│
│ id          │◄────│ knowledge_id     │     │ id          │
│ question    │     │ agent_id         │◄────│ name        │
│ answer      │     │ UNIQUE(k_id,a_id)│     │ ...         │
└─────────────┘     └──────────────────┘     └─────────────┘
```

**优势**：
- 一条知识可复用于多个 agent
- 删除 agent 时自动解除关联（ON DELETE CASCADE）
- 知识本身独立存在，不依赖特定 agent

---

## 总结

### 数据隔离方式对比

| 模块 | 关联方式 | 全局数据 | 专属数据 | 查询机制 |
|------|----------|----------|----------|----------|
| **Memory** | `agent_id + scope` | scope='global', agent_id=NULL | scope='agent', agent_id=必填 | 合并全局 + 专属 |
| **Tools** | 配置字段过滤 | COMMON_SET | tools_list + user_tools_list | `getAgentTools()` 三层过滤 |
| **Skills** | `agent_id` 直接关联 | agent_id=NULL | agent_id=必填 | 优先专属，fallback 全局 |
| **Knowledge** | 多对多关联表 | 可关联多个 agent | 通过 knowledge_agents 关联 | JOIN 关联表过滤 |

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
| Prompt 构建 | `src/llm/agents/prompt.ts` |
| Agent 运行时 | `src/llm/agent.ts` |