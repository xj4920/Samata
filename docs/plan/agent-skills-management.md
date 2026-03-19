# Agent Skills 管理机制

## 全局工具注册

所有工具在 `src/llm/agent.ts` 中静态定义（约 40+ 个），通过 `getGlobalTools()` 暴露。

工具分类：
- 客户管理：query_clients, view_client, add_client, update_client...
- 知识库：search_knowledge, update_knowledge, assign_knowledge_agent...
- 交易数据：query_trades, plot_trades, list_customers
- Skill 模板：list_skills, get_skill, save_skill, delete_skill
- Agent 管理：list_agents, get_agent, save_agent, delete_agent, switch_agent
- 记忆系统：save_memory, search_memory, delete_memory, update_memory
- 系统工具：read_file, write_file, edit_file, reload_app, get_status_summary...

## 工具过滤机制

每个 agent 在 DB 中有两个字段控制工具访问：
- `tools_mode`: `'all'` | `'allowlist'` | `'blocklist'`
- `tools_list`: JSON 数组，工具名列表

过滤逻辑在 `src/llm/agents/config.ts:189` 的 `getAgentTools()`:
```typescript
export function getAgentTools(agent: AgentConfig, globalTools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (agent.toolsMode === 'all') return globalTools;
  const set = new Set(agent.toolsList);
  if (agent.toolsMode === 'allowlist') return globalTools.filter(t => set.has(t.name));
  return globalTools.filter(t => !set.has(t.name)); // blocklist
}
```

在 `runAgenticChat()` (`src/llm/agent.ts:1163`) 中调用：
```typescript
const activeTools = agent ? getAgentTools(agent, tools) : tools;
```

## Tutor Agent 初始化

在 `src/db/schema.ts:181` 首次启动时 seed（仅当 agents 表为空时执行）：

```typescript
const commonTools = JSON.stringify([
  'search_knowledge', 'list_skills', 'get_skill', 'save_skill', 'delete_skill',
  'get_status_summary', 'list_agents', 'get_agent', 'save_agent', 'delete_agent', 'switch_agent',
  'save_memory', 'search_memory', 'delete_memory',
  'read_file', 'write_file', 'reload_app',
]);
ins.run('agent-tutor', 'tutor', '教育辅导', '孩子学习辅导、作业答疑、学习规划', 'allowlist', commonTools, 'admin-001');
```

Tutor 使用 `allowlist` 模式，共 **16 个工具**，不包含客户管理、交易查询等业务工具。

## 运行时工具解析流程

```
用户输入
  → resolveAgent(channel, appId, targetId)  // 找到 tutor AgentConfig
  → runAgenticChat(messages, input, user, { agentConfig: tutor })
  → getAgentTools(tutor, globalTools)        // 过滤出 16 个工具
  → LLM 请求（携带过滤后的工具列表）
  → executeTool(name, input)                 // 工具调用分发
```

## 关键文件

| 文件 | 作用 |
|------|------|
| `src/llm/agent.ts` | 全局工具定义、executeTool 分发、runAgenticChat |
| `src/llm/agents/config.ts:189` | getAgentTools() 过滤逻辑 |
| `src/db/schema.ts:166-182` | tutor agent seed 数据（commonTools 定义） |
