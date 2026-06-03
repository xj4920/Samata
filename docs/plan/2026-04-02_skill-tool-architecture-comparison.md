---
docModules:
  - plugins
  - permissions
docTopics:
  plugins: Tool / Skill / MCP
  permissions: 工具可见性
canonicalDocs:
  - /plugins/sdk-and-lifecycle
  - /permissions/tool-access
status: implemented
---

# Samata vs OpenClaw vs Claude Code: Skill & Tool 架构对比分析

**日期：** 2026-04-02
**背景：** 梳理 Samata 项目的 skill/tool 体系与 OpenClaw / Claude Code 的差异，明确对齐方向和合理保留点。

---

## 一、三方 Skill 定义对比

### Claude Code / OpenClaw 中 Skill 的本质

> "Skills teach the agent how and when to use tools."

Skill 是**教会 agent 如何使用工具的知识文档**，不是可执行模板。

- **存储**：文件系统目录，入口文件 `SKILL.md`（YAML frontmatter + markdown 正文）
- **发现**：system prompt 中只注入名称 + 一句话描述（catalog）
- **加载**：LLM 通过 `read` 工具按需读取 `SKILL.md` 全文
- **执行**：**没有 `run_skill` 工具**。LLM 读完 skill 文档后，自主调用文档中描述的各种 tools
- **关系**：skill 不是 tool 的替代品，而是 tool 的使用说明书

OpenClaw `system-prompt.ts` 中的关键指令：

```
"If exactly one skill clearly applies: read its SKILL.md with `read` tool, then follow it."
"Constraints: never read more than one skill up front; only read after selecting."
```

### Samata 当前的 Skill 实现

| 维度 | Samata | OpenClaw / Claude Code |
|------|--------|----------------------|
| 存储 | SQLite DB（`prompt` + `description` 字段） | 文件系统 `SKILL.md` |
| 发现 | system prompt 注入名称+描述 | system prompt 注入名称+描述 |
| 加载 | `get_skill` 工具获取全文 | `read` 工具读 SKILL.md 文件 |
| 执行 | `run_skill` 替换 `{param}` 后返回 resolved prompt | 无 run_skill；LLM 读完后自主调用其他 tools |
| 内容格式 | 自由格式，支持 `{param}` 占位符 | 结构化 markdown（何时用/步骤/边界） |
| skill 与 tool 的关系 | 独立于 tool 的"可执行模板" | "教 LLM 怎么用 tools 的文档" |

### 已对齐的部分

- system prompt 轻量注入（名称+描述，不注入全文）
- 按需获取完整内容（`get_skill` 对应 OpenClaw 的 `read`）
- `description` 字段用于发现时机判断
- agent 作用域隔离

### 未对齐的核心差异

- `run_skill` + `{param}` 是 Samata 特有的"宏执行"模式，OpenClaw/Claude Code 中不存在
- OpenClaw 中 LLM 读完 skill 后直接调用已有 tools，不需要中间"执行器"
- 存储介质不同（DB vs 文件系统），但这是合理的架构选择，适合 Samata 的多 agent 动态管理场景

---

## 二、三方 Tool 架构对比

### OpenClaw 的 Tools 来源（混合架构）

| 来源 | 说明 |
|------|------|
| Native tools | 内置核心工具（`read`, `write`, `edit`, `exec` 等），进程内直接执行 |
| Plugin tools | 通过插件注册（`registerTool`），进程内执行 |
| MCP tools | 通过 MCP 协议连接外部服务，补充层 |
| LSP tools | 语言服务器提供的工具 |
| Client tools | OpenResponses 风格的远程工具 |

所有来源合并为 `effectiveTools` 统一列表：

```
effectiveTools = nativeTools + pluginTools + mcpTools + lspTools
```

对 LLM 来说无差别，统一走 Anthropic `tool_use` 协议。

### Samata 的 Tools 来源

| 来源 | 说明 |
|------|------|
| Native tools（`src/tools/*.ts`） | 13 个模块，40+ 个工具，业务逻辑直接实现在服务内 |
| MCP tools（`src/services/mcp-manager.ts`） | 通过 MCP 连接外部服务，以 `mcp_` 前缀区分 |

```typescript
// src/llm/agent.ts
export function getGlobalTools(): Anthropic.Tool[] {
  return [...getAllNativeTools(), ...getMcpTools()];
}

export async function executeTool(name: string, input: any): Promise<string> {
  if (name.startsWith('mcp_')) return callMcpTool(name, input);
  return executeNativeTool(name, input, ctx);
}
```

### Tool 性质的关键差异

| 维度 | OpenClaw | Samata |
|------|----------|--------|
| Native tools 性质 | 通用编程原语（读写文件、执行命令、浏览器） | 业务领域工具（查客户、查交易、管知识库） |
| Tool 层次 | 底层原语，skill 在上层编排 | 直接是业务能力，skill 是快捷封装 |
| MCP 角色 | 扩展能力的方式之一 | 扩展能力的方式之一 |
| 调用协议 | Anthropic tool_use | Anthropic tool_use |

两者架构模式相同（native + MCP 混合），核心差异在于 tools 的抽象层次。

---

## 三、多 Agent 与权限管理对比

### OpenClaw 的多 Agent 模型

OpenClaw 支持多 Agent，但 Agent 概念更接近"不同配置的工作 profile"（同一 owner 的不同 workspace/coding agent），定义在配置文件 `openclaw.json` 中：

```typescript
// config types.agents.ts
type AgentConfig = {
  id: string;              // "main", "reviewer", "deploy-bot"
  default?: boolean;
  workspace?: string;      // 绑定不同工作目录
  model?: AgentModelConfig;
  skills?: string[];       // skill 白名单
  tools?: AgentToolsConfig; // tool 策略
  subagents?: { allowAgents?: string[]; ... };
};
```

### Samata 的多 Agent 模型

Samata 的 Agent 是面向不同用户群的独立角色（otcclaw/tutor/alter-ego/doctor），定义在 SQLite DB 的 `agents` 表中，配合 `users` 表 + `agent_members` 表实现多用户访问。

### 权限机制对比

| 维度 | OpenClaw | Samata |
|------|----------|--------|
| Agent 定义 | 配置文件 `openclaw.json` | SQLite DB `agents` 表 |
| Agent 本质 | 同一 owner 的不同工作 profile | 面向不同用户群的独立角色 |
| 用户系统 | 单 owner（owner vs non-owner） | 多用户（users + agent_members 表） |
| 权限模型 | 多层策略合并（config-driven） | RBAC（systemAdmin / agentAdmin / user） |
| Tool 控制 | allow/deny/profile 策略叠加 | allowlist / blocklist 模式 |
| Skill 控制 | 白名单（config 数组） | agent_id 外键绑定 |
| 跨 Agent 隔离 | session visibility + A2A policy | agent_id 作用域 + RBAC 校验 |
| 自举能力 | 无（agent 不能修改自己的配置） | 有（admin 通过 save_skill/save_agent 自我管理） |

### OpenClaw Tool 权限的多层策略

```
全局 tools policy
  + 按 provider 覆盖（byProvider）
    + 按 agent 覆盖（agents.list[].tools）
      + group policy
        + sandbox policy
          + subagent policy
            = effectiveToolPolicy
```

每层可设 `allow`（白名单）、`alsoAllow`（追加）、`deny`（黑名单）、`profile`（预设模板）。

### OpenClaw 跨 Agent 隔离

Session 可见性控制：

```typescript
tools.sessions.visibility: "self" | "tree" | "agent" | "all"
```

- `self`：只看自己的 session
- `tree`：看自己和子 agent（默认值）
- `agent`：同 agentId 下所有 session
- `all`：跨 agent（需 `agentToAgent.enabled` 配合）

Subagent 生成需 `allowAgents` 白名单授权，子 agent 默认继承更严格的 tool deny list。

---

## 四、结论与建议

### Samata 不需要照搬的部分

1. **文件系统存储 skill**：DB 存储更适合 Samata 的多 agent 动态管理 + 多用户场景
2. **Config-driven 权限模型**：Samata 的 RBAC 更适合多用户访问控制
3. **多层策略合并**：Samata 的 allowlist/blocklist 足够简洁有效

### Samata 可以借鉴的部分

1. **Skill 内容规范**：skill 的 `prompt` 字段应遵循结构化 markdown 格式（何时用/步骤/边界/输出格式），而非短字符串模板
2. **Skill 执行理念**：鼓励 LLM 读完 skill 后自主调用 tools，而非依赖 `run_skill` 做模板替换。`run_skill` 可保留作为快捷方式，但不应是主要使用模式
3. **Skill 发现指令**：system prompt 中可加入更明确的 skill 使用指导（如 OpenClaw 的"scan descriptions → pick one → read → follow"流程）

### 当前对齐状态

| 对齐维度 | 状态 |
|----------|------|
| Skill 发现（轻量注入 catalog） | 已对齐 |
| Skill 按需加载（get_skill） | 已对齐 |
| Skill 内容结构（markdown 文档） | 部分对齐（格式规范待推广） |
| Skill 执行理念（LLM 自主调用 tools） | 未对齐（仍依赖 run_skill 宏） |
| Tool 架构（native + MCP 混合） | 已对齐 |
| 多 Agent 隔离 | 已对齐（方案不同但目标一致） |
| 权限管理 | Samata 的 RBAC 更完善（多用户场景） |
