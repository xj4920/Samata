---
docModules:
  - platform
  - external-data
  - plugins
docTopics:
  platform: Agent 能力模型
  external-data: 报价与交易
  plugins: Tool / Skill / MCP
canonicalDocs:
  - /platform/agent-capability-model
  - /external-data/pricing-and-trade
  - /plugins/sdk-and-lifecycle
status: implemented
---

# OTC Claw（衍语）功能架构说明

> Samata 平台核心 Agent —— 从自然语言到数据查询、知识运用和工具执行的完整链路

---

## 一、自然语言如何调用到客户/交易数据？

### 1.1 整体流程

```
用户输入自然语言
    │
    ▼
┌──────────────────┐
│  runAgenticChat  │  ← 统一入口（CLI / 飞书 / Telegram / 企微 共用）
│  src/llm/agent.ts│
└────────┬─────────┘
         │ 1. 构建 system prompt（含角色、权限、记忆、技能列表）
         │ 2. 收集当前 agent 可用的 tools（JSON Schema 定义）
         │ 3. 组装 messages（历史 + 用户输入）
         ▼
┌──────────────────┐
│   LLM API 调用    │  ← Claude / DeepSeek / 其他 Provider
│   model + tools   │
└────────┬─────────┘
         │ LLM 返回 stop_reason: 'tool_use'
         │ + tool_use blocks（工具名 + 参数）
         ▼
┌──────────────────┐
│   工具执行循环     │  ← while (stop_reason === 'tool_use')
│   executeTool()   │
└────────┬─────────┘
         │ 执行结果作为 tool_result 返回给 LLM
         │ LLM 综合结果生成自然语言回复
         ▼
    最终文本回复
```

**关键机制**：LLM 不是通过关键词匹配决定调用哪个工具，而是基于每个工具的 **名称、描述和参数 JSON Schema** 来理解工具能力，自主决定是否调用、调用哪个、传什么参数。

### 1.2 具体示例：「帮我查一下 LinkRiver 最近的交易情况」

```
1. 用户输入 → "帮我查一下 LinkRiver 最近的交易情况"

2. LLM 收到 system prompt + tools 定义，其中包括：
   - query_trades: "查询交易成交数据，支持按 client/party/user/date 筛选"
     参数: { client?: string, party?: string, date?: string, limit?: number }

3. LLM 自主决策 → 调用 query_trades({ client: "LinkRiver" })

4. executeTool("query_trades", { client: "LinkRiver" })
   → src/tools/trade-tools.ts 的 handler
   → src/commands/trade.ts 的 fetchTrades()
   → loadCustomers() 从配置文件读取 LinkRiver 下辖的所有交易对手（counter_party）
   → queryTrades() 向 InfluxDB 发起 Flux 查询
   → 返回交易记录数组

5. 工具返回结果（JSON）作为 tool_result 推入对话历史

6. LLM 基于交易数据生成可读的中文摘要回复给用户
```

### 1.3 客户数据的查询链路

| 层次 | 组件 | 说明 |
|------|------|------|
| 工具定义 | `query_clients` | LLM 可调用，支持 keyword/state 过滤 |
| 命令层 | `src/commands/client.ts` → `fetchClients()` | 业务逻辑，SQL 查询 |
| 存储 | SQLite `clients` 表 | 字段：name, contact, state, requirements, tags 等 |

客户状态流转：`Initial Contact → Requirement Discussion → Solution Design → UAT → PROD`

System prompt 中硬编码了工具使用规范，要求 LLM **必须从用户问题中提取关键词**传入 `keyword` 参数，避免全量查询：

> 用户问"极速客户" → keyword="极速"，用户问"某某公司" → keyword="某某"

### 1.4 交易数据的查询链路

| 层次 | 组件 | 说明 |
|------|------|------|
| 工具定义 | `query_trades` / `trade_summary` | LLM 可调用 |
| 命令层 | `src/commands/trade.ts` → `fetchTrades()` | 管理人名 → 展开交易对手列表 → 查询 |
| 映射配置 | `src/config/customers.js` → `loadCustomers()` | 管理人 → counter_party 映射关系 |
| 存储 | **InfluxDB**（时序数据库） | 交易日、交易对手、名义金额、持仓等 |

交易数据与客户数据分离存储：客户 CRM 数据在 SQLite，交易成交数据在 InfluxDB。`fetchTrades()` 先通过配置文件将管理人名展开为旗下所有交易对手名，再向 InfluxDB 发起查询，最后将结果按交易金额排序返回。

---

## 二、知识以什么方式提供给 LLM 使用？

### 2.1 三种知识注入机制

OTC Claw 通过 **三种互补机制** 将知识提供给 LLM：

```
┌─────────────────────────────────────────────────────────┐
│                    System Prompt                         │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ 角色指令  │  │  记忆（Memory）│  │ 技能目录（Skills）│  │
│  │ 权限描述  │  │  全局 + Agent │  │  名称 + 简介     │  │
│  └──────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────┘
                        ↑ 每轮对话开始时构建

┌─────────────────────────────────────────────────────────┐
│                 工具调用（按需检索）                       │
│                                                         │
│  search_knowledge ── 关键词搜索知识库 ── 结果进入对话上下文 │
│  search_memory ───── 关键词搜索记忆 ── 结果进入对话上下文   │
│  get_skill / run_skill ── 获取完整技能模板                │
└─────────────────────────────────────────────────────────┘
                        ↑ LLM 判断需要时主动调用
```

### 2.2 记忆（Memory）—— 始终在场的上下文

记忆自动注入到每轮对话的 system prompt 末尾，LLM **无需调用工具即可看到**：

- **全局记忆**：最近 50 条，所有 Agent 共享
- **Agent 记忆**：最近 30 条，仅当前 Agent 可见

存储在 SQLite `memory` 表，每条最长 500 字。格式示例：

```markdown
## 记忆（重要上下文，请在回答时参考）
### 全局记忆
- LinkRiver 使用 FIX 协议接入，对接人是张三
- 客户 Jump 的技术负责人邮箱已更新为 xxx@jump.com
### 当前 Agent 记忆
- 本周重点跟进磐松北上对接进度
```

### 2.3 知识库（Knowledge）—— 按需检索的 FAQ

知识库**不会**自动注入 system prompt（避免上下文过长），而是通过 `search_knowledge` 工具**按需检索**：

- 存储在 SQLite `knowledge` 表（question + answer + tags）
- 检索方式：**关键词匹配 + 相关性评分**（非向量语义检索）
  - 将搜索词按空格拆分为多个关键词
  - 每个关键词在 question 中匹配 +3 分、tags +2 分、answer +1 分
  - 按总分降序排列返回
- 通过 `knowledge_agents` 多对多关联表实现 **Agent 级别的知识隔离**

### 2.4 技能（Skills）—— 可复用的提示词模板

技能的**名称和简介**注入 system prompt，但**完整内容**需要 LLM 调用工具获取：

```
System Prompt 中：
🛠️ 可用技能 (Skills)：
- 「展业话术」: 根据客户状态和需求生成专业的 OTC 展业话术...
- 「交易日报」: 生成每日交易汇总报告模板...

当场景匹配某个技能时，使用 run_skill 执行，使用 get_skill 获取完整内容。
```

技能支持 `{param}` 占位符模板，`run_skill` 会解析参数后返回完整的提示词，供 LLM 在后续推理中使用。

---

## 三、LLM 能使用哪些 Tools / Skills？

### 3.1 工具全景图

按功能域分类，系统共注册 **50+ 个原生工具**，加上插件工具和 MCP 动态工具：

#### 客户管理（CRM）

| 工具名 | 功能 | 权限 |
|--------|------|------|
| `query_clients` | 按关键词/状态查询客户列表 | 所有用户 |
| `view_client` | 查看单个客户详情 | 所有用户 |
| `get_client_history` | 查看客户事件历史 | 所有用户 |
| `add_client` | 新增客户 | 系统管理员 |
| `update_client` | 修改客户信息 | 系统管理员 |
| `advance_client` | 推进客户到下一阶段 | 系统管理员 |
| `rollback_client` | 回退客户到上一阶段 | 系统管理员 |

#### 交易查询

| 工具名 | 功能 |
|--------|------|
| `query_trades` | 查询交易记录（支持按管理人/交易对手/日期筛选） |
| `trade_summary` | 按管理人汇总的交易日报 |
| `plot_trades` | 生成交易数据可视化图表（HTML） |
| `list_customers` | 列出所有管理人及其交易对手映射 |

#### 知识库

| 工具名 | 功能 |
|--------|------|
| `search_knowledge` | 关键词搜索知识库 FAQ |
| `add_knowledge` | 新增 FAQ 条目 |
| `update_knowledge` | 更新 FAQ |
| `delete_knowledge` | 删除 FAQ |
| `assign_knowledge_agent` | 将知识关联到指定 Agent |
| `unassign_knowledge_agent` | 取消知识与 Agent 的关联 |

#### 技能管理

| 工具名 | 功能 |
|--------|------|
| `list_skills` | 列出所有可用技能 |
| `get_skill` | 获取技能完整内容 |
| `save_skill` | 创建或更新技能 |
| `delete_skill` | 删除技能 |
| `run_skill` | 执行技能（解析参数模板，返回完整提示词） |

#### 记忆系统

| 工具名 | 功能 |
|--------|------|
| `save_memory` | 保存一条记忆（全局或 Agent 级别） |
| `search_memory` | 关键词搜索记忆 |
| `update_memory` | 更新记忆内容 |
| `delete_memory` | 删除记忆 |

#### Agent 管理

| 工具名 | 功能 | 渠道限制 |
|--------|------|----------|
| `list_agents` | 列出所有 Agent | CLI 专属 |
| `get_agent` | 查看 Agent 配置 | CLI 专属 |
| `save_agent` | 创建/更新 Agent | CLI 专属 |
| `delete_agent` | 删除 Agent | CLI 专属 |
| `switch_agent` | 切换当前会话的 Agent | CLI 专属 |
| `manage_agent_member` | 管理 Agent 成员 | CLI 专属 |
| `assign_agent` / `unassign_agent` | 绑定/解绑 Agent 到渠道 | CLI 专属 |

#### 文件与系统

| 工具名 | 功能 |
|--------|------|
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件 |
| `edit_file` | 搜索替换编辑文件 |
| `list_directory` | 列出目录内容 |
| `exec_cmd` | 执行 Shell 命令（Agent 管理员） |
| `reload_app` | 热重载应用 |

#### 内容生成与发送

| 工具名 | 功能 |
|--------|------|
| `write_artifact` | 将内容写入临时文件 |
| `send_file` | 发送文件给用户 |
| `send_image` | 发送图片给用户 |
| `markdown_to_image` | Markdown 渲染为 PNG |
| `generate_image` | 文生图（MiniMax） |
| `generate_video` | 文生视频（MiniMax） |

#### 提醒与待办

| 工具名 | 功能 |
|--------|------|
| `set_reminder` / `list_reminders` / `cancel_reminder` | 定时提醒管理 |
| `create_todo` / `list_todos` / `update_todo` / `delete_todo` | 待办事项管理 |

#### 其他

| 工具名 | 功能 |
|--------|------|
| `get_status_summary` | 系统状态（版本、模型、数据量、运行时间） |
| `http_request` | HTTP 请求（通用型，始终可用） |
| `extract_wework_qa` | 从企微聊天记录中提取 Q&A |

### 3.2 插件工具

通过 `plugins/` 目录扩展，自动加载：

| 插件 | 工具名 | 功能 |
|------|--------|------|
| export-csv | `export_clients_csv` | 导出客户数据为 CSV |
| excel-parser | `parse_excel` / `list_excel_sheets` | 解析 Excel/CSV 文件 |

### 3.3 MCP 动态工具

通过 MCP（Model Context Protocol）协议动态加载外部工具，工具名格式为 `mcp_<server>_<tool>`。配置在 `config/mcp-servers.json`，例如 Playwright 浏览器工具。

### 3.4 Skills（技能）

Skills 是**提示词模板**，不是代码工具。它们存储在数据库中，可通过 `run_skill` 动态执行：

```
示例技能「展业话术」：
  prompt: "请根据以下客户信息生成 OTC 衍生品展业话术：
           客户名称：{client_name}
           当前阶段：{stage}
           需求：{requirements}"
```

LLM 调用 `run_skill({ name: "展业话术", params: { client_name: "XX基金", stage: "方案设计", requirements: "利率互换" } })` 后，系统解析模板返回完整提示词，LLM 据此生成话术。

---

## 四、Tools / Skills 如何管理？

### 4.1 三层过滤架构

```
全局工具池（Native + Plugins + MCP）
    │
    ▼ Layer 1: Agent 级别过滤
┌───────────────────────────────────────────────────┐
│ tools_mode 决定 Agent 可用工具范围                   │
│                                                   │
│  'all'      → 全部工具 − block_tools              │
│  'standard' → COMMON_SET ∪ tools_list − block_tools│
│  'allowlist' → 仅 tools_list 中的工具（旧版兼容）    │
└───────────────────┬───────────────────────────────┘
                    │
                    ▼ Layer 2: 用户级别过滤（仅非管理员）
┌───────────────────────────────────────────────────┐
│ user_tools_mode 进一步限制普通用户                    │
│                                                   │
│  'inherit'    → 与管理员相同（默认）                  │
│  'allowlist'  → 与 Agent 有效集取交集                │
│  'blocklist'  → 从 Agent 有效集中减去                │
│  'all'        → 不受 Agent 限制                     │
└───────────────────┬───────────────────────────────┘
                    │
                    ▼ Layer 3: 通道与通用规则
┌───────────────────────────────────────────────────┐
│ • UNIVERSAL_TOOLS (http_request) → 始终添加         │
│ • CLI_ONLY_TOOLS (Agent管理类) → 非 CLI 渠道自动移除 │
└───────────────────────────────────────────────────┘
```

### 4.2 COMMON_SET —— 标准模式的基础工具集

`standard` 模式下，每个 Agent 默认拥有以下基础工具：

- **知识库**：search_knowledge, add_knowledge, update_knowledge, delete_knowledge
- **技能**：list_skills, get_skill, save_skill, delete_skill, run_skill
- **系统**：get_status_summary
- **记忆**：save_memory, search_memory, delete_memory
- **发送**：write_artifact, send_file, send_image
- **提醒**：set_reminder, list_reminders, cancel_reminder
- **待办**：create_todo, list_todos, update_todo, delete_todo
- **媒体**：generate_image, generate_video

在此基础上，通过 `tools_list` 添加额外工具，通过 `block_tools` 屏蔽不需要的工具。

### 4.3 四个默认 Agent 的工具配置

| Agent | 角色 | tools_mode | 说明 |
|-------|------|------------|------|
| otcclaw（衍语） | OTC 业务专家 | `all` | 拥有全部工具，包括客户管理和交易查询 |
| tutor（教育辅导） | 学习辅导 | `standard` | COMMON_SET + 特定附加 |
| alter-ego（数字分身） | 个人助手 | `standard` | COMMON_SET + 企微提取等 |
| doctor（家庭医生） | 健康咨询 | `standard` | COMMON_SET + 健康记录工具 |

### 4.4 Skills 的管理

Skills 支持两个作用域：

- **全局 Skill**：`agent_id = NULL`，所有 Agent 可见
- **Agent Skill**：绑定特定 `agent_id`，仅该 Agent 可见

管理权限遵循 RBAC：

| 操作 | 系统管理员 | Agent 管理员 | 普通用户 |
|------|-----------|-------------|---------|
| 查看技能 | 全部 | 当前 Agent | 当前 Agent |
| 创建/修改技能 | 全部 | 当前 Agent 范围 | 不可 |
| 删除技能 | 全部 | 当前 Agent 范围 | 不可 |

Skills 的来源：
1. **数据库 Skills**：通过 `save_skill` 工具或命令创建
2. **插件 Skills**：`plugins/*/SKILL.md` 文件自动加载

### 4.5 自举能力（Self-Bootstrapping）

OTC Claw 的一个重要特性是 **Agent 可以自我进化**：

- LLM 可以通过 `save_skill` 创建新的提示词模板
- LLM 可以通过 `write_file` / `edit_file` 修改项目源代码
- LLM 可以通过 `reload_app` 使代码变更立即生效

这意味着 Agent 管理员可以通过自然语言对话来扩展系统能力，无需手动编程。

### 4.6 权限层级总结

```
系统管理员（CLI + admin role）
  ├─ 管理所有 Agent 的配置（tools_mode, tools_list, block_tools）
  ├─ 管理全局知识库和 Skill
  └─ 执行任意工具

Agent 管理员（agent_members.role = 'admin'）
  ├─ 管理当前 Agent 的 Skill 和知识
  ├─ 使用当前 Agent 允许的所有工具
  └─ 自举：创建 Skill、修改代码

普通用户
  └─ 仅使用 user_tools_mode 允许的工具子集
```

---

## 附：架构要点总结

1. **统一入口**：所有渠道（CLI、飞书、Telegram、企微）共用 `runAgenticChat()`，保证行为一致
2. **工具驱动**：LLM 通过 Function Calling 协议自主决定调用哪些工具，系统只负责执行和权限校验
3. **知识按需检索**：知识库内容不预加载到 prompt，通过工具调用按需获取，节省上下文窗口
4. **记忆常驻**：重要上下文通过 Memory 机制自动注入 system prompt
5. **多层过滤**：Agent 级别 → 用户级别 → 渠道级别，精细控制每个用户看到的工具集
6. **可扩展**：支持插件工具、MCP 动态工具、用户自创 Skill 三种扩展方式
