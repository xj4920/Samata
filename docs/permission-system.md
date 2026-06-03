# Samata 权限管理机制

Samata 采用三层 RBAC 权限模型：**System Admin → Agent Admin → Agent User**，结合执行上下文（channel）、全局角色、per-agent 角色、三层工具过滤，实现细粒度的权限隔离。

---

## 一、System Admin（系统管理员）

### 判定条件

```
isSystemAdmin() = getExecutionChannel() === 'cli' && getCurrentUser().role === 'admin'
```

**核心约束**：bot channel（飞书/Telegram/企微）**永远不能成为 system admin**，即使 DB 中 `users.role = 'admin'`。这是双条件门控——必须同时在 CLI channel 且具有 admin 角色。

> 代码位置：`src/auth/rbac.ts` — `isSystemAdmin()`、`requireAdmin()`

### 权限范围

| 类别 | 具体权限 | 通道限制 |
|---|---|---|
| 全局资源 | memory/knowledge/skill 的全局读写 | 无限制 |
| Agent 管理 | create/del/assign/unassign/bot-app | 仅 CLI |
| 用户管理 | `/user add/update/delete` | 仅 CLI |
| 高危工具 | `write_file`、`edit_file`、`reload_app` | 仅 CLI |
| 监控/运维 | `/bot`（bot启停） | 仅 CLI |
| 隐式继承 | 自动成为所有 agent 的 admin | — |

### CLI-only 命令

以下命令设置了 `cliOnly: true`，在 bot channel 完全不可见：

- `/user` — 系统用户管理
- `/bot` — Bot 启停

### Agent 管理工具的双重守卫

Agent 管理工具（`save_agent`、`delete_agent`、`assign_agent` 等 10 个）有两层限制：

1. **工具过滤层**：`CLI_ONLY_TOOLS` 在非 CLI channel 的 `getAgentTools()` 中被移除
2. **运行时层**：`src/tools/agent-tools.ts:238` 在 handler 中再次检查 `getExecutionChannel() !== 'cli'` 并拒绝

---

## 二、Agent Admin（Agent 管理员）

### 判定条件

```
isAgentAdmin(agentId) = isSystemAdmin()  // 自动通过
                    || getAgentMembershipRole(agentId) === 'admin'  // agent_members 表
```

System admin 自动获得所有 agent 的 admin 身份，无需 `agent_members` 记录。

> 代码位置：`src/auth/rbac.ts` — `isAgentAdmin()`、`requireAgentAdmin()`

### 权限范围

| 类别 | 具体权限 |
|---|---|
| 成员管理 | `/agent member add/del`（仅限自己管理的 agent） |
| 自举能力 | `save_skill`、`delete_skill`（仅限自己管理的 agent） |
| Knowledge 写入 | FAQ add/update/delete、`ensureKnowledgeWriteAccess(agentId)` |
| Document 写入 | `import_document`、`delete_document` |
| Memory 写入 | agent 级 memory add/update/delete |
| Agent 配置 | `/model` 切换、tools_mode 等 |
| 业务写入 | `add_client`、`update_client`、`import_pricing_schedule` 等（otcclaw agent） |

### 限制

- **不可操作全局资源**：全局 memory/knowledge/skill 需 system admin 权限
- **不可跨 agent 管理**：`isAgentAdmin(agentId)` 仅对特定 agent 生效
- **不可创建/删除 agent**：`/agent create/del/assign/unassign/bot-app` 仅 system admin + CLI

### /agent 子命令权限矩阵

| 子命令 | System Admin (CLI) | Agent Admin | Agent User |
|---|---|---|---|
| `list` | ✅ | ✅ | ✅ |
| `switch` | ✅ | ✅ | ✅ |
| `info` | ✅ | ✅ | ✅ |
| `member` | ✅ | ✅ | ❌ |
| `create` | ✅ | ❌ | ❌ |
| `del` | ✅ | ❌ | ❌ |
| `assign` | ✅ | ❌ | ❌ |
| `unassign` | ✅ | ❌ | ❌ |
| `assignments` | ✅ | ❌ | ❌ |
| `bot-app` | ✅ | ❌ | ❌ |

> 代码位置：`src/commands/agent.ts:9-52`

---

## 三、Agent User（普通用户）

### 判定条件

```
isAgentMember(agentId) = isSystemAdmin()  // 自动通过
                      || getAgentMembershipRole(agentId) !== null  // 任意 membership（含 role='user'）
```

> 代码位置：`src/auth/rbac.ts` — `isAgentMember()`

### 权限范围

| 类别 | 具体权限 |
|---|---|
| 只读查询 | `search_knowledge`、`query_clients`、`view_client`、`list_documents`、`list_memory`、`search_memory` |
| 使用型操作 | `run_skill`、`generate_image`、`generate_video`、`calculate_date`、`send_file`、`http_request` |

### 限制

- **不可写入任何资源**：knowledge/skill/memory/document 的 add/update/delete 均被拒绝
- **user_tools_list blocklist** 阻止 mutation 工具（seed 数据包含 23+ 个工具）
- **LLM 权限描述注入**：system prompt 中会提示"不可新增、修改、删除"

### /memory 命令权限细节

| 操作 | System Admin | Agent Admin | Agent User |
|---|---|---|---|
| `list` | ✅ | ✅ | ✅ |
| `search` | ✅ | ✅ | ✅ |
| `add --scope=global` | ✅ | ❌ | ❌ |
| `add --scope=agent` | ✅ | ✅ | ❌ |
| `del`（全局记忆） | ✅ | ❌ | ❌ |
| `del`（agent 记忆） | ✅ | ✅ | ❌ |

> 代码位置：`src/llm/agents/memory.ts:43-49` — `getMemoryWriteError()`

---

## 四、工具过滤三层机制

每个用户的最终可用工具集由三层过滤叠加决定：

```
最终可用工具集 =

  Layer 1（Agent 层）:
    tools_mode='standard': COMMON_SET ∪ toolsList ∪ pluginTools − blockTools
    tools_mode='all':      allGlobalTools − blockTools

  Layer 2（User 层，仅非 admin 用户生效）:
    user_tools_mode='blocklist':  减去 user_tools_list
    user_tools_mode='allowlist':  交集 user_tools_list
    user_tools_mode='inherit':    不做额外过滤（与 agent admin 相同）
    user_tools_mode='all':        绕过 Layer 1，直接使用全部工具

  Layer 3（Channel 层，始终生效）:
    + UNIVERSAL_TOOLS (http_request)
    − CLI_ONLY_TOOLS (10 个 agent 管理工具，非 CLI channel 移除)
```

> 代码位置：`src/llm/agents/config.ts:368-409` — `getAgentTools()`

### COMMON_SET（29 个基础工具）

所有 `tools_mode='standard'` 的 agent 自动拥有：

| 类别 | 工具 |
|---|---|
| Knowledge | `search_knowledge`、`add_knowledge`、`update_knowledge`、`delete_knowledge`、`list_knowledge_recent` |
| Skill | `list_skills`、`get_skill`、`save_skill`、`delete_skill`、`run_skill` |
| Memory | `save_memory`、`search_memory`、`delete_memory` |
| Delivery | `write_artifact`、`send_file`、`send_image` |
| Reminder | `set_reminder`、`list_reminders`、`cancel_reminder` |
| Todo | `create_todo`、`list_todos`、`update_todo`、`delete_todo` |
| Media | `generate_image`、`generate_video` |
| Document | `import_document`、`list_documents`、`delete_document` |
| Date | `calculate_date` |
| System | `get_status_summary` |

### CLI_ONLY_TOOLS（10 个，非 CLI channel 移除）

`list_agents`、`get_agent`、`manage_agent_member`、`list_agent_members`、`save_agent`、`delete_agent`、`switch_agent`、`assign_agent`、`unassign_agent`、`list_agent_assignments`

### User Blocklist 默认种子（23 个 mutation 工具）

`exec_cmd`、`reload_app`、`read_file`、`list_directory`、`write_file`、`edit_file`、`add_knowledge`、`update_knowledge`、`delete_knowledge`、`assign_knowledge_agent`、`unassign_knowledge_agent`、`save_skill`、`delete_skill`、`save_memory`、`update_memory`、`delete_memory`、`create_todo`、`update_todo`、`delete_todo`、`set_reminder`、`cancel_reminder`、`import_document`、`delete_document`

> 代码位置：`src/db/schema.ts` — `seed-member-default-blocklist` migration

---

## 五、命令级权限矩阵

| 命令 | requiredRole | cliOnly | System Admin | Agent Admin | Agent User |
|---|---|---|---|---|---|
| `/status` | none | no | ✅ | ✅ | ✅ |
| `/faq` | none | no | ✅ | ✅ | ✅ |
| `/faq-add/update/del` | agent_admin | no | ✅ | ✅ | ❌ |
| `/faq-tags-check` | agent_admin | no | ✅ | ✅ | ❌ |
| `/doc-list` | none | no | ✅ | ✅ | ✅ |
| `/doc-import/del/retag` | agent_admin | no | ✅ | ✅ | ❌ |
| `/plugin` | none | no | ✅ | ✅ | ✅ |
| `/skill` | none | no | ✅ | ✅(读+agent写) | ✅(只读) |
| `/memory` | none | no | ✅(读+全局写) | ✅(读+agent写) | ✅(只读) |
| `/agent list/switch/info` | none | no | ✅ | ✅ | ✅ |
| `/agent member` | — | no | ✅ | ✅ | ❌ |
| `/model` | agent_admin | no | ✅ | ✅ | ❌ |
| `/user` | system_admin | yes | ✅ | ❌ | ❌ |
| `/bot` | system_admin | yes | ✅ | ❌ | ❌ |

> 代码位置：`src/commands/router.ts:34-60` — 命令定义；`router.ts:153-162` — `shouldShowCommand()`

---

## 六、LLM 权限描述注入

`buildPermissionText()` 根据用户角色生成四档描述，通过 `{{permissions}}` 占位符注入 system prompt，引导 LLM 自行约束行为：

| 角色 | LLM 看到的描述 |
|---|---|
| System Admin | "CLI 系统管理员，可管理全局 memory/knowledge/skill，也可管理所有 agent" |
| Agent Admin | "Agent「X」的管理员，可写当前 Agent 的 memory/knowledge/skill，但不可操作全局资源" |
| Agent Member | "Agent「X」的普通成员，可查询和使用当前 Agent 资源，不可新增、修改、删除" |
| No membership | "没有写权限，只能执行只读查询和使用型操作" |

> 这是软约束（LLM 可能不遵守），硬约束在工具 handler 的 RBAC 检查中。

> 代码位置：`src/llm/agents/prompt.ts:20-41` — `buildPermissionText()`

---

## 七、权限继承关系

```
System Admin (CLI + admin role)
  ├── 自动继承所有 Agent Admin 权限
  ├── 自动继承所有 Agent Member 权限
  └── 独占：全局资源、Agent CRUD、用户管理、高危工具

Agent Admin (agent_members.role='admin')
  ├── 自动继承 Agent Member 权限
  └── 独占：该 Agent 的写入操作、成员管理、自举能力

Agent User (agent_members.role='user' 或无 membership)
  └── 仅：只读查询 + 使用型操作
```

---

## 八、新增工具权限 Checklist

每次新增 tool 时，必须同步决定它在每个 agent 的归属，否则会出现 LLM 被引导去调但 agent 的 `tools_list` 里没有，导致"工具不在当前用户的允许列表中"错误。

1. **定位业务归属**：全 agent 通用还是某个 agent 专属？
   - 只读类 → 加入 `COMMON_SET`（`src/llm/agents/config.ts`）
   - agent 专属 → 通过 migration 补进该 agent 的 `tools_list`

2. **区分读写性质**：
   - 写操作 → 必须加入该 agent 的 `user_tools_list` blocklist
   - 只读 → 不加 user blocklist
   - 高危 → 仅 system admin 可用

3. **写 migration**：在 `src/db/schema.ts` 末尾新增幂等 `runOnce`，补进 `tools_list` / `user_tools_list`

4. **验证**：`/reload_app` 后用 SQL 确认两列已更新，再用 admin/普通成员各测试一次

---

## 关键文件索引

| 文件 | 职责 |
|---|---|
| `src/auth/rbac.ts` | 核心权限函数：`isSystemAdmin`、`isAgentAdmin`、`isAgentMember`、`requireAdmin`、`requireAgentAdmin` |
| `src/runtime/execution-context.ts` | 执行上下文：`AppChannel`、`AsyncLocalStorage`、`getExecutionChannel` |
| `src/llm/agents/config.ts` | 工具过滤：`COMMON_SET`、`CLI_ONLY_TOOLS`、`getAgentTools()` |
| `src/commands/router.ts` | 命令级权限：`Command` interface（`requiredRole`、`cliOnly`）、`shouldShowCommand()` |
| `src/llm/agents/prompt.ts` | `buildPermissionText()` — LLM 权限描述注入 |
| `src/llm/agents/memory.ts` | `getMemoryWriteError()` — memory 写权限 |
| `src/commands/knowledge.ts` | `ensureKnowledgeWriteAccess()` — knowledge 写权限 |
| `src/commands/skill.ts` | `saveSkill`/`deleteSkill` 权限检查 |
| `src/commands/agent.ts` | agent 子命令权限矩阵 |
| `src/db/schema.ts` | DB schema、seed data、migrations |
| `src/tools/agent-tools.ts` | CLI-only channel 双重守卫 |
