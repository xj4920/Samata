# Project Memory

## 环境规范
- 永远使用本地的 venv 环境执行 Python 命令（`source venv/bin/activate` 或使用 `venv/bin/python`）
- **严禁在代码中 hardcode 绝对路径**。所有路径必须通过环境变量、配置文件或相对路径获取，不得在源码中写死如 `/Users/xxx/...` 这类绝对路径

## 项目结构规范
- `scripts/` 目录仅存放脚本，严禁在其中编写业务代码
- 所有代码统一放到 `src/` 目录，按功能分类管理
- 所有计划文档必须写入 `docs/plan/` 目录，文件名格式：`YYYY-MM-DD_<topic>.md`

## 数据注意事项
- `knowledge_pending` 表的 `auto_quality_score` 字段 99% 为 NULL（仅 5 条有值），不可用作排序或筛选依据

## 企业微信数据目录
- **位置**: `~/Documents/my/XBase/dump/wework`
- **结构**:
  - 约400+个企微群组目录（以客户名或业务名命名）
  - `.txt` 文件：每日聊天记录（JSON格式，每条消息包含 id, create_time, ctype, content, from_user_id, from_user_nickname, to_user_id, to_user_nickname, is_group 等字段）
- **关键客户群组示例**:
  - LinkRiver相关：`LinkRiver- GF-多空交易群`、`LinkRiver系统对接`
  - 磐松相关：`广发-磐松北上对接`、`广发-磐松北上技术群`、`磐松后勤组`
  - 孝庸相关：`孝庸-广发香港北上对接`
  - Jinde相关：`Jinde-广发股衍香港IT对接`、`jinde- GFHK估值沟通`
  - Jump相关：`Jump&GF系统连接群`、`Jump系统对接服务`
  - SCHONFELD相关：`Schonfeld交易数据加工`
  - 贝塔相关：`贝塔（对冲策略）&广发FIX（极速）对接2群`

## 架构规范

### 命令与工具复用
- Agent tools（`src/llm/agent.ts` 中的 tool handlers）必须复用 `src/commands/` 下已有的命令函数，禁止在 handler 中重新实现业务逻辑
- 命令函数应导出可复用的数据函数（如 `fetchTrades`），tool handler 只做薄包装：调用命令函数 → JSON.stringify 返回结果
- 新增 tool 时，先在 `src/commands/` 中实现并导出核心逻辑，再在 agent.ts 中添加 tool 定义和 handler 调用

### Bot 与 CLI 逻辑一致性（重要）
**原则：CLI 是标准实现，所有 bot（飞书、Telegram 等）必须与 CLI 保持完全一致**

#### Agentic Chat 逻辑共享
- **禁止**在 bot 中重复实现 agentic loop（tool use 循环）
- **必须**使用 `src/llm/agent.ts` 中的 `runAgenticChat()` 函数
- **必须**使用相同的 tools（通过 `getTools()`）和 system prompt（通过 `getSystemPrompt()`）

#### 正确的实现方式
```typescript
// ✅ 正确：飞书/Telegram bot 的 handleAIChat 实现
import { runAgenticChat } from '../llm/agent.js';

async function handleAIChat(userInput: string, userId: string, username: string): Promise<string> {
  const session = getSession(userId, username);

  // 临时切换用户上下文
  const prevUser = getCurrentUser();
  setCurrentUser(session.user);

  try {
    // 控制历史长度
    while (session.history.length > MAX_HISTORY * 2) {
      session.history.shift();
    }

    // 使用共享的 agentic chat 逻辑
    const textReply = await runAgenticChat(session.history, userInput, session.user, {
      streamEnabled: false,
      logPrefix: `[Bot:${username}] `,
      showThinking: true,
    });

    return textReply || '（无回复内容）';
  } finally {
    setCurrentUser(prevUser);
  }
}
```

#### 错误的实现方式
```typescript
// ❌ 错误：不要在 bot 中重复实现 agentic loop
async function handleAIChat(userInput: string): Promise<string> {
  // ❌ 不要手动实现 tool use 循环
  while (response.stop_reason === 'tool_use') {
    // ... 重复的逻辑
  }
}
```

#### 修改 Agentic 逻辑时
- 只需修改 `src/llm/agent.ts` 中的 `runAgenticChat()` 函数
- 所有入口（CLI、飞书、Telegram）会自动保持一致
- 无需在多个地方同步修改

### Agent Skills 工具过滤机制
每个 agent 在 DB 中通过两个字段控制工具访问：
- `tools_mode`: `'all'` | `'allowlist'` | `'blocklist'`
- `tools_list`: JSON 数组，工具名列表

过滤逻辑在 `src/llm/agents/config.ts:189` 的 `getAgentTools()`，在 `runAgenticChat()` 中调用：
```typescript
const activeTools = agent ? getAgentTools(agent, tools) : tools;
```

Tutor agent 使用 `allowlist`模式，16 个工具（知识库、skill 管理、agent 管理、记忆、系统工具），seed 数据在 `src/db/schema.ts:166-182`。

详细架构见 `docs/plan/agent-skills-management.md`。

### Samata 多 Agent 架构约束

**项目标识**
- 本项目名称为 **Samata**，支持多个 agent 实例同时运行

**默认四个 Agent 角色**（seed 数据在 `src/db/schema.ts`）

| Agent ID    | 角色名称   | 说明                         |
|-------------|----------|------------------------------|
| otcclaw     | 工作助理   | OTC Claw，tools_mode='all'   |
| tutor       | 家庭教育   | 教育辅导，allowlist 模式       |
| alter-ego   | 数字分身   | 个人分身，alterEgo 工具集      |
| doctor      | 家庭医生   | 健康咨询，common 工具集        |

**接口设计规范：必须携带 agent_id**
- 所有返回 agent 作用域数据的接口（knowledge、skill、memory、tool 列表等），必须接受 `agentId` 参数并按其过滤结果
- 现有参考实现：
  - `fetchKnowledge(keyword?, agentId?)` → `src/commands/knowledge.ts`
  - `getAllSkills(agentId?)` → `src/commands/skill.ts`
  - `fetchMemory(agentId?)` → `src/llm/agents/memory.ts`
  - `getAgentTools(agent, globalTools)` → `src/llm/agents/config.ts`
- 新增工具或命令时，若涉及 agent 隔离数据，必须遵循上述模式

**权限层级**

```
系统管理员 (isSystemAdmin)
  ├─ 全局权限：创建/删除任意 agent，管理全局 skill/knowledge
  └─ CLI 直接修改代码权限（仅系统管理员拥有）

Agent 实例管理人 (isAgentAdmin(agentId))
  ├─ 管理该 agent 的成员（add/del）
  ├─ 修改该 agent 的配置（system_prompt、model、tools_mode 等）
  └─ 自举能力：管理该 agent 的 skill 和 tools（save_skill、delete_skill）

普通用户
  └─ 只能在 agent 允许的工具和 skill 范围内使用，无自举权限
```

**Agent 自举能力（Self-Bootstrapping）**
- "自举能力"指 agent 实例自我管理 skill 和 tools 的能力（`save_skill`、`delete_skill`、`save_agent`、`delete_agent` 等工具）
- 自举工具只能由该 agent 的实例管理人（`agent_members.role='admin'`）调用
- 普通用户调用自举工具时，必须在工具 handler 中通过 `isAgentAdmin(agentId)` 校验并拒绝
- 权限检查参考：`src/llm/agents/config.ts` 中的 `isAgentAdmin()` 函数

**Agent 实例权限初始值**
- 新建 agent 时，其 `tools_mode` 和 `tools_list` 参考对应角色的默认值（见 seed 数据）
- 创建者自动成为该 agent 的 admin（`agent_members` 表，role='admin'）