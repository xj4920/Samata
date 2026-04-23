# Project Memory

## 环境规范
- 永远使用本地的 venv 环境执行 Python 命令（`source venv/bin/activate` 或使用 `venv/bin/python`）
- **严禁在代码中 hardcode 绝对路径**。所有路径必须通过环境变量、配置文件或相对路径获取，不得在源码中写死如 `/Users/xxx/...` 这类绝对路径

## 项目结构规范
- `scripts/` 目录仅存放脚本，严禁在其中编写业务代码
- 所有代码统一放到 `src/` 目录，按功能分类管理
- 所有计划文档必须写入 `docs/plan/` 目录，文件名格式：`YYYY-MM-DD_<topic>.md`
- 当使用 Cursor Plan Mode 创建计划时，**必须同时**在 `docs/plan/` 中创建对应的 markdown 文件，确保计划进入 git 版本管理

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

### 执行上下文与 Channel 隔离

所有执行路径都必须携带 channel 标识��通过 `src/runtime/execution-context.ts` 的 `AsyncLocalStorage`）：

```typescript
type AppChannel = 'cli' | 'feishu' | 'telegram' | 'wework' | 'system';
```

- CLI server 在执行命令时注入 `{ channel: 'cli' }`
- 飞书/Telegram/WeWork bot 注入对应 channel
- `isSystemAdmin()` = `channel === 'cli' && role === 'admin'`，bot channel 永远不满足
- `/agent` 管理操作（save/delete/switch）在 tool 层检查 `getExecutionChannel() !== 'cli'` 并拒绝

### CLI 客户端/服务端架构

CLI 通过 HTTP/SSE 与 server 交互，不直连 DB：

- `npm run server` — 启动主进程（DB、bot、`http://127.0.0.1:3457` CLI API；避开 ccr 默认的 3456）
- `npm run cli` — ��动 CLI 客户端（`src/cli/index.ts`，连接 server）

**SSE streaming 端点**（`/api/cli/stream`）：agentic chat 通过 SSE 实时推送文本 chunk 和 tool 进度，消除黑屏等待。

关键文件：
- `src/cli/` — CLI 客户端（REPL + SSE 解析）
- `src/server/` — CLI API server（session 管理 + SSE executor）
- `src/shared/cli-contract.ts` — 客户端/服务端共享类型（`CliStreamEvent`）

### 命令与工具复用- Agent tools（`src/llm/agent.ts` 中的 tool handlers）必须复用 `src/commands/` 下已有的命令函数，禁止在 handler 中重新实现业务逻辑
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

### Plugin 分层约束（严禁反向引用 native tool）

`plugins/` 下的插件与 `src/` 下的 server native 工具是两个分层：

- **Native 工具**（`src/tools/`、`src/llm/agent.ts` 等）可以感知插件，因为 server 是编排方
- **Plugin**（`plugins/<name>/index.ts`）**严禁**在 `toolDefinitions.description` 或任何对外描述中：
  - 提及 native 工具名（如 `import_pricing_schedule`、`query_clients`、`view_client` 等）
  - 写"请改用 xxx 工具"之类的反引导
  - 假设 server 端的业务语义（如 customers.json 映射、clients 表结构）

原因：插件是可独立加载/卸载的模块，不应耦合 server 端业务；一旦插件引用了 native tool，拆装或换 server 就会产生虚假引用和误导性提示。

**工具选择的反引导**（"该用 A 不该用 B"）必须写在 server 层：
- system prompt（`src/llm/agents/prompt.ts`）
- 文件注入提示（`src/runtime/file-hint.ts`）
- native tool 自己的 description

**正例**：`parse_excel` 描述只写"解析 Excel/CSV 文件..."；"若是 Pricing Schedule 请改用 import_pricing_schedule" 写在 system prompt 里。

### Agent System Prompt 存放位置

- 所有 agent 的 system prompt 存放在 `config/agents/<name>.md`，git 版本管理，是**唯一来源**
- 占位符由 `src/llm/agents/prompt.ts` 在运行时替换：
  - `{{agent.displayName}}` / `{{agent.description}}` — agent 元数据
  - `{{permissions}}` — 用户权限说明（`buildPermissionText` 输出）
  - `{{attachments}}` — 附件发送规范
  - `{{skills}}` — 可用 skills 列表（无 skill 时为空）
  - `{{memory}}` — 全局 + agent 记忆块（无记忆时为空）
- 找不到对应 `<name>.md` 时 fallback 到 `_default.md`
- 禁止把 prompt 硬编码到 TS 代码里，也禁止存进 DB（`agents.system_prompt` 列已删除）
- `save_agent` 工具 / `/agent create` CLI 不支持改 prompt，需要系统管理员直接编辑 MD 文件（修改后 `reload_app` 或重启即可生效）
- **新增 seed agent 时必须同步创建 `config/agents/<name>.md`**（末尾带上 `{{permissions}}` / `{{attachments}}` / `{{skills}}` / `{{memory}}` 占位符块），否则会静默走 `_default.md` fallback 而丢失角色个性
- **严禁在 agent md 文件中静态描述工具的能力或用法**（如"支持 .md/.docx/.xlsx/.csv"、"默认 dry_run=true 预览"等）。工具做什么由 `src/tools/*.ts` 的 `toolDefinitions[].description` 定义，LLM 通过 API 的 `tools` 参数已经看到。agent md 中只写**路由指引**（什么场景选哪个工具、什么不该做），不重复工具自身描述，避免与实现脱节

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

### 新增 Agent Tool 时的权限矩阵规范（重要）

每次新增 tool（在 `src/tools/` 下注册 `toolDefinitions`）后，**必须同步**决定它在每个 agent 的归属，不允许只加 tool 定义就收工——否则会出现 system prompt / file-hint 引导 LLM 去调，但 agent 的 `tools_list` 里没有，LLM 命中 "工具不在当前用户的允许列表中" 的错误（历史案例：`import_pricing_schedule`）。

新增 tool 时**必走的 checklist**：

1. **定位 tool 的业务归属**：是全 agent 通用还是某个 agent 专属？
   - 全通用、只读类（search/query）→ 加入 `COMMON_SET`（`src/llm/agents/config.ts`），所有 `tools_mode='standard'` 的 agent 自动生效
   - 某个 agent 专属（如 otcclaw 的 client/trade/pricing 系列）→ **不要动** `COMMON_SET`，只通过 migration 补进该 agent 的 `tools_list`

2. **区分读写性质，决定 user blocklist**：
   - 写操作（add/update/delete/import/advance/rollback 等会改 DB 的）→ **必须**同步加进该 agent 的 `user_tools_list` blocklist，让普通成员（非 agent admin）不能调用；参考 otcclaw 现有 blocklist：`add_client / update_client / import_document / import_pricing_schedule` 等
   - 纯只读（query/view/list/search）→ 不加 user blocklist，普通成员可用
   - 破坏性 / 高权限（`exec_cmd`、`reload_app`、`write_file`、`edit_file`）→ 必须进 user blocklist，且仅系统管理员级别可用

3. **加 migration 而不是手改 DB**：
   - 在 `src/db/schema.ts` 末尾新增 `runOnce('<agent>-add-<tool>', ...)`，幂等地补进 `tools_list` / `user_tools_list`
   - 不要 rename 已执行过的 migration id；要调整旧结果就新加一个 migration
   - 模板参考 `otcclaw-add-import-pricing-schedule`（[src/db/schema.ts](src/db/schema.ts)）

4. **验证**：重启或 `/reload_app` 后用 SQL 确认两列都已更新
   ```sql
   SELECT tools_list, user_tools_list FROM agents WHERE name='<agent>';
   ```
   再用 agent admin / 普通成员各跑一次，确认 admin 能调、普通成员被拒。

不遵循此规范的后果：新增 tool 在任何 agent 上都调不起来（agent-level 过滤兜住了），或者普通成员意外拿到写权限（user blocklist 漏补）。

### Samata 多 Agent 架构约束

**项目标识**
- 本项目名称为 **Samata**，立意「技术平权」，支持多个 agent 实例同时运行

**默认四个 Agent 角色**（seed 数据在 `src/db/schema.ts`）

| Agent ID    | 中文名     | tools_mode | 说明                                      |
|-------------|----------|-----------|-------------------------------------------|
| otcclaw     | 衍语      | standard  | OTC 业务专家，额外工具：client/trade/pricing 系列 |
| tutor       | 教育辅导   | standard  | 教育辅导，纯 COMMON_SET                     |
| alter-ego   | 数字分身   | all       | 个人分身，block 业务专属工具                  |
| doctor      | 家庭医生   | standard  | 健康咨询，额外工具：health 系列               |

> `standard` 模式有效工具 = COMMON_SET ∪ tools_list ∪ plugin 工具 ∪ MCP 工具，可通过 block_tools 屏蔽

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
  = channel==='cli' AND role==='admin'
  ├─ 全局权限：创建/删除任意 agent，管理全局 skill/knowledge
  └─ CLI 直接修改代码权限（仅系统管理员拥有）
  注：飞书/Telegram/WeWork channel 进来的用户永远不是系统管理员

Agent 实例管理人 (isAgentAdmin(agentId))
  = isSystemAdmin OR agent_members.role='admin'
  ├─ 管理该 agent 的成员（add/del）
  ├─ 修改该 agent 的配置（model、tools_mode 等；system prompt 在 config/agents/<name>.md）
  └─ 自举能力：管理该 agent 的 skill 和 tools（save_skill、delete_skill）

普通用户
  └─ 只能在 agent 允许的工具和 skill 范围内使用，无自举权限
```

**Agent 自举能力（Self-Bootstrapping）**
- "自举能力"指 agent 实例自我管理 skill 和 tools 的能力（`save_skill`、`delete_skill`、`save_agent`、`delete_agent` 等工具）
- 自举工具只能由该 agent 的实例管理人（`agent_members.role='admin'`）调用
- 普通用户调用自举工具时，必须在工具 handler 中通过 `isAgentAdmin(agentId)` 校验并拒绝
- 权限检查参考：`src/auth/rbac.ts` 中的 `isAgentAdmin()` 函数

**Agent 实例权限初始值**
- 新建 agent 时，其 `tools_mode` 和 `tools_list` 参考对应角色的默认值（见 seed 数据）
- 创建者自动成为该 agent 的 admin（`agent_members` 表，role='admin'）