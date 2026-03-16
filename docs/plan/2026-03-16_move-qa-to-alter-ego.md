# 将 QA 功能从 OtcClaw 迁移到个人分身

## Context

OtcClaw 定位为展业助理（OTC 业务专家），不应承担知识库 QA 相关功能。当前 OtcClaw 使用 `toolsMode: 'all'`，拥有所有工具（含 QA 相关的 `search_knowledge`、`update_knowledge`、`extract_wework_qa`）。需要将这些 QA 工具从 OtcClaw 移除，转移到「个人分身」(alter-ego) agent 下。

## 涉及的 QA 工具

| 工具名 | 功能 |
|---|---|
| `search_knowledge` | 搜索知识库 FAQ |
| `update_knowledge` | 更新知识库条目（管理员） |
| `extract_wework_qa` | 从企微聊天记录提取 Q&A |

## 修改计划

### 1. OtcClaw — 屏蔽 QA 工具

**文件**: `src/llm/agents/config.ts` (line 21-29)

将 `DEFAULT_AGENT`（代码级 fallback）从 `toolsMode: 'all'` 改为 `blocklist`，排除 3 个 QA 工具：

```typescript
const DEFAULT_AGENT: AgentConfig = {
  ...
  toolsMode: 'blocklist',
  toolsList: ['search_knowledge', 'update_knowledge', 'extract_wework_qa'],
  ...
};
```

### 2. 个人分身 — 添加 QA 工具

**文件**: `src/db/schema.ts` (line 158-167)

在 seed 的 `commonTools` 之外，为 `alter-ego` 单独定义包含 QA 工具的工具列表：

```typescript
const alterEgoTools = JSON.stringify([
  ...commonToolsArray,
  'update_knowledge', 'extract_wework_qa',
]);
```

- `alter-ego` 使用 `alterEgoTools`（已包含 commonTools 中的 `search_knowledge` + 新增 `update_knowledge` 和 `extract_wework_qa`）
- 其他 agent（doctor、tutor）保持 `commonTools` 不变

同时更新 OtcClaw 的 seed：

```typescript
ins.run('agent-otcclaw', ..., 'blocklist',
  JSON.stringify(['search_knowledge', 'update_knowledge', 'extract_wework_qa']),
  'admin-001');
```

### 3. 添加 DB 迁移 — 更新已有部署的数据

**文件**: `src/db/schema.ts`

在 schema 文件末尾添加迁移逻辑，更新已有的 agent 记录：

```typescript
// Migration: Move QA tools from otcclaw to alter-ego
const otcclawAgent = db.prepare("SELECT tools_mode FROM agents WHERE name = 'otcclaw'").get();
if (otcclawAgent && otcclawAgent.tools_mode === 'all') {
  db.prepare("UPDATE agents SET tools_mode = 'blocklist', tools_list = ? WHERE name = 'otcclaw'")
    .run(JSON.stringify(['search_knowledge', 'update_knowledge', 'extract_wework_qa']));
}

const alterEgo = db.prepare("SELECT tools_list FROM agents WHERE name = 'alter-ego'").get();
if (alterEgo) {
  const current = alterEgo.tools_list ? JSON.parse(alterEgo.tools_list) : [];
  const toAdd = ['update_knowledge', 'extract_wework_qa'];
  const updated = [...new Set([...current, ...toAdd])];
  db.prepare("UPDATE agents SET tools_list = ? WHERE name = 'alter-ego'")
    .run(JSON.stringify(updated));
}
```

### 4. 移除 OtcClaw system prompt 中的 QA 描述

**文件**: `src/llm/agents/prompt.ts` (line 13)

从 `getDefaultSystemPrompt` 中删除第 5 条：`5. 搜索知识库回答常见问题`

## 不需要修改的文件

- `src/llm/agent.ts` — 工具定义和 handler 保持不变，过滤由 `getAgentTools()` 控制
- `src/commands/knowledge.ts` / `src/commands/wework-qa.ts` — 命令实现不变，CLI 仍可使用

## 验证方式

1. `npm run build` 确保编译通过
2. 启动应用，切换到 otcclaw agent，确认没有 `search_knowledge`、`update_knowledge`、`extract_wework_qa` 工具
3. 切换到 alter-ego agent，确认包含这三个 QA 工具
4. 其他 agent（doctor、tutor）工具列表不受影响
