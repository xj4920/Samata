# 执行计划：Agent 级别权限管理与系统管理员隔离

## 1. 需求理解 (Requirement Understanding)
目前系统中的权限（RBAC）仅有全局级别的区分（`admin` 与 `user`）。所有的 `admin` 可以对所有资源进行修改。
**目标需求：**
1. **系统管理员 (System Admin)**：保留当前的全局 `admin` 角色，能够对系统级别配置（如全量Agent管理、模型切换）进行操作。
2. **Agent 管理员 (Agent Admin)**：能够对自己管辖的 Agent 的配置（如 Tools、Skills 绑定、System Prompt）进行编辑。
3. **Agent 普通用户 (Agent User)**：只能在自己可访问的 Agent 下进行对话或使用被授权的 Tools/Skills，无法进行配置修改。

## 2. 影响范围 (Impact Scope)
- **数据库 Schema**: 需要增加用户与 Agent 之间的角色映射关系表。
- **权限模块**: `src/auth/rbac.ts` 需要增加基于 Agent ID 的权限判断函数。
- **业务逻辑层**: 涉及所有对 Agent 和 Skill 进行写入或修改的命令及 AI Tools，包括：
  - `src/commands/agent.ts` & `src/llm/agents/config.ts`
  - `src/commands/skill.ts`
  - `src/llm/agent.ts` (tool handlers)

## 3. 详细实施步骤 (Implementation Steps)

### 步骤 1: 数据库结构扩展
- 修改 `src/db/schema.ts`，在 `initSchema` 中增加 `agent_members` 表，结构如下：
  - `id`: 主键
  - `agent_id`: 关联 `agents(id)`
  - `user_id`: 关联 `users(id)`
  - `role`: 'admin' | 'user'（指代在当前 Agent 中的角色）
  - `created_at`: 时间戳
- 在 `initSchema` 中增加自动迁移（Migration）逻辑：
  如果系统中已存在老数据，则将已有的管理员自动设定为各内置 Agent 的 Admin（平滑过渡）。

### 步骤 2: 扩展 RBAC 权限判断
- 修改 `src/auth/rbac.ts`，新增以下函数：
  - `isSystemAdmin()`: 兼容目前的 `isAdmin()`，即判断当前用户的全局 `users.role` 是否为 `'admin'`。
  - `isAgentAdmin(agentId: string)`: 判断当前用户是否是 System Admin，**或者**在 `agent_members` 表中具有该 `agentId` 下的 `admin` 角色。
  - `requireAgentAdmin(agentId: string)`: 断言函数，无权限则抛出异常。

### 步骤 3: 改造 `saveAgent` 和 `deleteAgent` 逻辑
- 修改 `src/llm/agents/config.ts`：
  - 在 `saveAgent` 中，更新记录前需要验证当前用户具有该 Agent 的 `AgentAdmin` 权限（或 `SystemAdmin`）。
  - 创建新 Agent 时，默认将当前创建者作为该 Agent 的 `AgentAdmin` 插入到 `agent_members` 表中。
  - 删除 Agent (`deleteAgent`) 必须需要 `SystemAdmin` 或 `AgentAdmin` 权限。

### 步骤 4: 改造 `saveSkill` 和 `deleteSkill` 逻辑
- 修改 `src/commands/skill.ts`：
  - 在 `saveSkill` 时：
    - 如果 `agentId` 为空（全局 Skill），必须是 `SystemAdmin`。
    - 如果指定了 `agentId`（专属 Skill），必须是 `SystemAdmin` 或该 Agent 的 `AgentAdmin`。
  - 在 `deleteSkill` 时，做同等级别的鉴权。

### 步骤 5: 修改 AI Agent 侧的 Tool Handlers
- 修改 `src/llm/agent.ts`：
  - 更新 `handleSaveAgent`、`handleDeleteAgent`、`handleSaveSkill` 等对应的工具层代码，将旧的简单的 `isAdmin()` 校验替换为新版的细粒度校验，并在报错时返回清晰的 JSON error message 提示前端（大模型）。

### 步骤 6: 增加 CLI 授权命令 (可选扩展，增强易用性)
- 在 `src/commands/agent.ts` 中新增子命令 `/agent member add <agent_name> <username> <role>`，供 SystemAdmin 或 AgentAdmin 分配权限。

## 4. 验收标准 (Acceptance Criteria)
1. 全局管理员能够无阻碍地增删改查任何 Agent 和 Skill。
2. 当一个普通用户被指定为 `alter-ego` 的管理员后，他可以保存 `agentId` 为 `alter-ego` 的 Skill 和修改该 Agent 的配置，但如果去修改 `otcclaw` 则会报“权限不足”。
3. 试图保存全局 Skill 且非系统管理员时，会提示“需系统管理员权限”。
4. 程序的 `npm run dev` 构建不报错，重启应用后通过 SQLite 查询能看到 `agent_members` 关联表的成功创建。