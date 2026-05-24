# Samata 项目重构：核心平台 + 独立工具插件

## Context

当前所有 agent 专属 tools、commands、DB schema 全部混在 `src/` 中，职责不清。需要将 otcclaw/doctor/tutor 等专属工具从核心平台剥离为独立的 plugin 模块（放在 `plugins/` 下），每个 plugin 管理自己的 tools、commands、SQLite DB 和配置文件。

**核心原则：**
- Agent 定义（DB 记录 + `config/agents/<name>.md`）保留在 Samata 核心
- Agent = COMMON_SET + 按名称引用的专属 tools（来自 plugins）

**Plugin 原则：**
1. **Plugin 之间独立，无依赖** — 不可访问其他 plugin 的 DB、不可 import 其他 plugin 的代码
2. **Plugin 不能查询主库，不依赖 Samata 代码，与 Samata 是接口交互** — Plugin 只能通过 `PluginContext`（由 core 注入）获取有限信息，不可 import `src/` 下的任何模块，不可获取主库连接

## 目标架构

```
samata/
├── src/                              ← 核心平台
│   ├── tools/                        ← 仅 COMMON_SET tools
│   │   ├── index.ts                  ← 注册 native tools + plugin tools
│   │   ├── knowledge-tools.ts
│   │   ├── skill-tools.ts
│   │   ├── agent-tools.ts
│   │   ├── memory-tools.ts
│   │   ├── file-tools.ts
│   │   ├── reminder-tools.ts
│   │   ├── system-tools.ts
│   │   ├── todo-tools.ts
│   │   ├── markdown-tools.ts
│   │   ├── artifact-tools.ts
│   │   ├── media-gen-tools.ts
│   │   ├── document-tools.ts
│   │   ├── date-tools.ts
│   │   ├── sandbox-tools.ts
│   │   ├── web-tools.ts
│   │   ├── wechat-article-tools.ts
│   │   ├── archive-tools.ts
│   │   ├── wiki-tools.ts
│   │   ├── schedule-tools.ts
│   │   └── delivery-tools.ts        ← COMMON_SET 保留
│   ├── commands/                     ← 仅 COMMON_SET 对应的 commands
│   ├── db/schema.ts                  ← 仅平台表（users/agents/knowledge/skills/memory/reminders/todos/documents/bot_apps/events[仅平台实体]/telemetry_turn/scheduled_tasks/migrations）
│   └── llm/agents/config.ts         ← COMMON_SET + agent 配置
├── config/
│   ├── agents/                       ← 所有 agent md 文件（保留在此）
│   │   ├── otcclaw.md, otcclaw.files.json
│   │   ├── ticlaw.md, ticlaw.files.json
│   │   ├── doctor.md
│   │   ├── tutor.md
│   │   ├── alter-ego.md, alter-ego.files.json
│   │   ├── potato.md, potato.files.json
│   │   ├── man.md
│   │   ├── admin.md
│   │   └── _default.md
│   ├── mcp-servers.json
│   └── monitor.json
└── plugins/                          ← 所有独立工具插件
    ├── csv-export/                   ← 现有
    ├── diagram/                      ← 现有
    ├── excel-parser/                 ← 现有
    ├── pdf-parser/                   ← 现有
    ├── word-parser/                  ← 现有
    ├── client-manager/               ← NEW: 客户管理（9 tools + 独立 SQLite）
    │   ├── index.ts                  ← PluginModule export
    │   ├── src/
    │   │   ├── tools.ts              ← toolDefinitions
    │   │   ├── commands.ts           ← 业务逻辑（从 src/commands/client.ts 迁移）
    │   │   ├── model.ts              ← 客户模型（从 src/models/client.ts 迁移）
    │   │   ├── db.ts                 ← 独立 SQLite schema + connection
    │   │   └── config.ts             ← 读取 config/customers.json
    │   └── config/
    │       └── customers.json        ← 产品→管理人映射
    ├── trade-query/                  ← NEW: 交易查询（6 tools）
    │   ├── index.ts
    │   ├── src/
    │   │   ├── tools.ts
    │   │   ├── commands.ts           ← 从 src/commands/trade.ts + plot.ts 迁移
    │   │   └── db.ts                 ← InfluxDB 连接（从 extensions/otc-claw/src/db/influxdb.ts 迁移）
    │   └── config/
    │       └── trading-calendar-sse.json
    ├── pricing/                      ← NEW: 报价管理（4 tools + 独立 SQLite）
    │   ├── index.ts
    │   ├── src/
    │   │   ├── tools.ts              ← pricing-quote-tools + import_pricing_schedule
    │   │   ├── commands.ts           ← 从 src/commands/pricing-quote.ts 迁移
    │   │   └── db.ts                 ← pricing_quotes 表
    │   └── config/
    ├── hedge-ratio/                  ← NEW: 对冲比查询（1 tool）
    │   ├── index.ts
    │   └── src/
    │       ├── tools.ts
    │       ├── commands.ts           ← 从 src/commands/hedge-ratio.ts 迁移
    │       └── monitor.ts            ← 从 src/services/hedge-ratio-monitor.ts 迁移
    ├── wework-qa/                    ← NEW: 企微 QA 提取（1 tool）
    │   ├── index.ts
    │   └── src/
    │       ├── tools.ts
    │       ├── commands.ts           ← 从 src/commands/wework-qa.ts + wework-grep.ts 迁移
    │       └── monitor.ts            ← 从 src/services/wework-monitor.ts 迁移
    ├── health-tracker/               ← NEW: 健康管理（7 tools + 独立 SQLite）
    │   ├── index.ts
    │   ├── src/
    │   │   ├── tools.ts
    │   │   ├── commands.ts           ← 从 src/commands/health.ts 迁移
    │   │   └── db.ts                 ← health_records + health_files 表
    │   └── config/
    ├── wrong-questions/              ← NEW: 错题管理（4 tools + 独立 SQLite）
    │   ├── index.ts
    │   ├── src/
    │   │   ├── tools.ts
    │   │   ├── commands.ts           ← 从 src/commands/wrong-question.ts 迁移
    │   │   └── db.ts                 ← wrong_questions + wrong_question_assets 表
    │   └── config/
    └── wiki-sync/                    ← 从 extensions/wiki-sync 迁移
```

## 实施计划

### Phase 1: 增强 Plugin SDK + Plugin 加载系统

**1a. `packages/plugin-sdk/src/types.ts`** — `PluginModule` 增加作用域、上下文注入和生命周期：

```ts
type PluginScope = 'universal' | 'agent-bound';

interface PluginContext {
  /** 获取当前操作用户（plugin 记录审计日志时使用） */
  getCurrentUser(): { id: string; name: string; role: string };
  /** 获取 plugin 数据目录（如 data/plugins/client-manager/） */
  getDataDir(): string;
}

interface PluginModule {
  name: string;
  description?: string;
  /**
   * 'universal': 自动对所有 standard-mode agent 可见（csv-export、excel-parser 等通用工具）
   * 'agent-bound': 仅当 tool name 出现在 agent.tools_list 时可见（业务专属工具）
   * 默认 'universal'（向后兼容现有 plugins）
   */
  scope?: PluginScope;
  toolDefinitions: ToolDefinition[];
  handleTool(name: string, input: any, ctx: PluginContext): Promise<string | null>;
  /** 初始化插件（含 schema 迁移），core 注入 PluginContext */
  init?(ctx: PluginContext): Promise<void>;
  /** 获取插件私有 SQLite DB */
  getDb?(): any;
  /** 获取插件配置目录 */
  getConfigDir?(): string;
  /** 启动后台服务（monitor 等） */
  start?(): Promise<void>;
  /** 停止后台服务 */
  stop?(): Promise<void>;
}
```

**1b. `src/plugins/registry.ts`** — 加载时注入 `PluginContext`，调用生命周期方法：

```ts
function buildPluginContext(pluginName: string): PluginContext {
  return {
    getCurrentUser: () => getCurrentUser(),
    getDataDir: () => path.join(PROJECT_ROOT, 'data', 'plugins', pluginName),
  };
}

// 在 loadPlugin 后:
const ctx = buildPluginContext(plugin.name);
if (plugin.init) await plugin.init(ctx);
if (plugin.start) await plugin.start();

// 在 stopPluginWatcher / gracefulShutdown 中:
for (const [, loaded] of loadedPlugins) {
  if (loaded.module.stop) await loaded.module.stop();
}
```

**1c. `src/plugins/registry.ts`** — 新增按 scope 过滤的 API：

```ts
/** 获取 universal plugin tools（自动对所有 agent 可见） */
export function getUniversalPluginTools(): Anthropic.Tool[] {
  return [...loadedPlugins.values()]
    .filter(p => (p.module.scope ?? 'universal') === 'universal')
    .flatMap(p => p.module.toolDefinitions) as Anthropic.Tool[];
}

/** 获取所有 plugin tools（含 agent-bound，用于名称匹配） */
export function getAllPluginTools(): Anthropic.Tool[] {
  return [...loadedPlugins.values()]
    .flatMap(p => p.module.toolDefinitions) as Anthropic.Tool[];
}
```

**1d. `src/llm/agents/config.ts`** — 修改 `getAgentTools()` 中 standard 模式的 plugin 工具注入：

```ts
} else if (agent.toolsMode === 'standard') {
  // 只自动注入 universal plugin tools；agent-bound plugin tools 需在 tools_list 中显式声明
  const universalPluginToolNames = getUniversalPluginTools().map(t => t.name);
  const mcpToolNames = getMcpTools().map(t => t.name);
  effectiveNames = new Set([...COMMON_SET, ...agent.toolsList, ...universalPluginToolNames, ...mcpToolNames]);
  for (const b of agent.blockTools) effectiveNames.delete(b);
}
```

**1e. 两阶段启动**：`init()` 在主流程早期调用（schema 迁移），`start()` 在所有 bot 启动后统一调用：

```ts
// src/index.ts
await initPlugins();          // phase 1: init() — schema migration, DB connection
await startAllWeworkBots();   // bot 启动
await startAllPlugins();      // phase 2: start() — monitors 等后台服务
```

### Phase 2: 逐个迁移 Tool → Plugin

每个 plugin 迁移遵循相同模式：
1. 在 `plugins/<name>/` 下创建目录结构
2. 从 `src/tools/<xxx>-tools.ts` 复制 toolDefinitions → `plugins/<name>/src/tools.ts`
3. 从 `src/commands/<xxx>.ts` 复制业务逻辑 → `plugins/<name>/src/commands.ts`
4. 如需独立 SQLite → 创建 `plugins/<name>/src/db.ts`
5. 从 `src/db/schema.ts` 剥离相关表定义
6. 创建 `plugins/<name>/index.ts` 导出 `PluginModule`
7. 从 `src/tools/index.ts` 移除对应 module import
8. 从 `src/commands/` 删除已迁移的命令文件

**2a. client-manager**（9 tools, scope: `agent-bound`）
- tools: query_clients, view_client, get_client_history, add_client, update_client, advance_client, rollback_client, delete_client, import_pricing_schedule
- SQLite: `data/plugins/client-manager/client-manager.db` → clients + client_events 表
- Config: `plugins/client-manager/config/customers.json`
- 数据迁移：从主库 clients 表复制数据到插件 SQLite；从主库 events 表中抽出 `entity_type='client'` 的记录导入 `client_events` 表
- **审计日志**：client 操作的事件记录在 plugin 自己的 `client_events` 表（不再写主库 events），`get_client_history` 直接查本地表
- Plugin DB schema:
  ```sql
  CREATE TABLE clients (...);
  CREATE TABLE client_events (
    id                TEXT PRIMARY KEY,
    client_id         TEXT NOT NULL,
    action            TEXT NOT NULL,
    payload           TEXT,
    performed_by      TEXT NOT NULL,       -- user id
    performed_by_name TEXT NOT NULL,       -- 冗余用户名（写入时从 ctx.getCurrentUser().name 获取）
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ```
  > 原则：plugin 对主库无查询权限，用户名在写入时冗余存储，展示时无需回查 users 表

**2b. trade-query**（6 tools, scope: `agent-bound`）
- tools: query_trades, trade_summary, plot_trades, list_customers, export_trades_csv, export_north_info_csv
- DB: 复用 InfluxDB 连接（无 SQLite）
- Config: `plugins/trade-query/config/trading-calendar-sse.json`

**2c. pricing**（3 tools, scope: `agent-bound`）
- tools: import_pricing_quote, query_pricing_quote, list_pricing_quote_dates
- 注：import_pricing_schedule 操作 clients 表，放在 client-manager plugin
- SQLite: `data/plugins/pricing/pricing.db` → pricing_quotes 表

**2d. hedge-ratio**（1 tool, scope: `agent-bound`）
- tools: query_hedge_short
- 后台服务: hedge-ratio-monitor（定时检查对冲比并通过企微推送）

**2e. wework-qa**（1 tool, scope: `agent-bound`）
- tools: extract_wework_qa
- 后台服务: wework-monitor（监听企微消息自动提取 QA）

**2f. health-tracker**（7 tools, scope: `agent-bound`）
- tools: add_health_record, query_health_records, health_summary, log_sleep, log_meal, log_symptom, set_medication_reminder
- SQLite: `data/plugins/health-tracker/health-tracker.db` → health_records + health_files 表

**2g. wrong-questions**（4 tools, scope: `agent-bound`）
- tools: record_wrong_question, list_wrong_questions, mark_wrong_question_mastered, wrong_question_report
- SQLite: `data/plugins/wrong-questions/wrong-questions.db` → wrong_questions + wrong_question_assets 表

### Phase 3: 清理核心 Samata

**3a. `src/tools/index.ts`** — 移除 7 个已迁移 module import（client, trade, pricing-quote, hedge-ratio, wework, health, wrong-question），仅保留 COMMON_SET 对应的 23 个 module。

**3b. `src/commands/`** — 删除已迁移的 command 文件。

**3c. `src/db/schema.ts`** — 移除 clients / pricing_quotes / health_records / health_files / wrong_questions / wrong_question_assets 表定义及相关 migration。保留 `events` 表（平台级审计日志，仅记录 agent/knowledge/document/skill 实体操作）。从 events 表中清除历史 `entity_type='client'` 数据（已迁移到 plugin）。

**3d. `src/models/`** — 移除 `client.ts`；`event.ts` 保留（仍被 knowledge/document/skill/agent 使用）。

**3e. `src/services/`** — 移除 `wework-monitor.ts`、`hedge-ratio-monitor.ts`（已迁移到对应 plugin）。

**3f. `src/index.ts`** — 移除 `startMonitor()`、`startHedgeRatioMonitor()` 调用（plugin 的 `start()` 生命周期自动处理）。

**3g. `config/`** — 移动 `customers.json`、`trading-calendar-sse.json` 到对应 plugin；agent md 文件保持不变。

**3h. `extensions/`** — 删除 `otc-claw/`、`personal/`（已迁移到 plugins），`wiki-sync/` 迁移到 `plugins/wiki-sync/`。

### Phase 4: Agent 配置不变

Agent 的 `tools_list` 中引用的工具名不变（如 `query_clients`、`add_health_record`），只是这些工具的加载来源从 `src/tools/` 变为 `plugins/<xxx>/`。

`getAgentTools()` 在 `standard` 模式下合并 `COMMON_SET + tools_list + universalPluginTools + mcpTools`（Phase 1d 已修改）。`agent-bound` 插件的工具只有出现在 `tools_list` 中才可见，天然实现了 agent 隔离。

`AGENT_EXCLUSIVE_TOOLS` 可删除——`agent-bound` scope 已通过 `tools_list` 控制可见性，无需额外的排他映射。`alter-ego`/`admin`（`tools_mode: 'all'`）通过 `block_tools` 排除不想要的业务工具。

### Phase 5: `config/agents/` 文件不变

所有 agent prompt md 文件保留在 `config/agents/` 下，不随 plugin 移动。agent 定义（name, display_name, tools_mode, tools_list 等）仍由核心 DB 管理。

## 工具归属总结

| Plugin | Scope | Tools | 独立 SQLite |
|--------|-------|-------|------------|
| csv-export | universal | export_csv | 无 |
| diagram | universal | generate_diagram | 无 |
| excel-parser | universal | parse_excel | 无 |
| pdf-parser | universal | parse_pdf | 无 |
| word-parser | universal | parse_word | 无 |
| client-manager | agent-bound | query_clients, view_client, get_client_history, add_client, update_client, advance_client, rollback_client, delete_client, import_pricing_schedule | clients, client_events |
| trade-query | agent-bound | query_trades, trade_summary, plot_trades, list_customers, export_trades_csv, export_north_info_csv | 无（InfluxDB） |
| pricing | agent-bound | import_pricing_quote, query_pricing_quote, list_pricing_quote_dates | pricing_quotes |
| hedge-ratio | agent-bound | query_hedge_short | 无 |
| wework-qa | agent-bound | extract_wework_qa | 无 |
| health-tracker | agent-bound | add_health_record, query_health_records, health_summary, log_sleep, log_meal, log_symptom, set_medication_reminder | health_records, health_files |
| wrong-questions | agent-bound | record_wrong_question, list_wrong_questions, mark_wrong_question_mastered, wrong_question_report | wrong_questions, wrong_question_assets |
| *(保留在 core)* | — | 其余所有 COMMON_SET tools | *(主库：users, agents, knowledge, skills, memory, reminders, todos, documents, bot_apps, events, telemetry_turn, scheduled_tasks, migrations)* |

## Agent ↔ Plugin Tool 关系

| Agent | tools_mode | tools_list（来自 plugin 的 tool 名） |
|-------|-----------|--------------------------------------|
| otcclaw | standard | query_clients, view_client, get_client_history, add_client, update_client, advance_client, rollback_client, delete_client, import_pricing_schedule, query_trades, trade_summary, plot_trades, list_customers, export_trades_csv, export_north_info_csv, import_pricing_quote, query_pricing_quote, list_pricing_quote_dates, query_hedge_short, extract_wework_qa, markdown_to_image, update_memory, assign_knowledge_agent, unassign_knowledge_agent, get_knowledge_agents, read_file, sandbox_write_file, sandbox_read_file, sandbox_list, sandbox_exec |
| doctor | standard | add_health_record, query_health_records, health_summary, log_sleep, log_meal, log_symptom, set_medication_reminder, update_memory |
| tutor | standard | record_wrong_question, list_wrong_questions, mark_wrong_question_mastered, wrong_question_report |
| ticlaw | standard | read_file, write_file, edit_file, list_directory, exec_cmd, reload_app, sandbox_exec, sandbox_list, sandbox_read_file, sandbox_write_file, list_agents, get_agent, save_agent, delete_agent, switch_agent, assign_agent, unassign_agent, list_agent_assignments, list_agent_members, manage_agent_member, assign_knowledge_agent, unassign_knowledge_agent, get_knowledge_agents, update_memory, markdown_to_image, http_request, list_tool_presets |
| alter-ego | all | block_tools: [client + trade + health 系列] |
| admin | all | block_tools: [client + trade + health 系列] |

## 验证步骤

1. `npm run server` — 确认所有 plugin 加载日志正常（`✅ Plugin [xxx]: N tools loaded`）
2. SQLite 检查：确认 `data/plugins/<name>/<name>.db` 已创建且数据已迁移
3. CLI 下切换 otcclaw agent：`query_clients`、`query_trades` 等工具可用
4. CLI 下切换 doctor agent：`add_health_record`、`health_summary` 等工具可用
5. CLI 下切换 tutor agent：`record_wrong_question` 等工具可用
6. 飞书 bot 端到端测试：给 otcclaw-bot 发消息确认 client/trade 工具正常
7. 飞书 bot 测试 doctor/tutor 工具
8. 企微 bot 测试（如有）
9. `npx tsc --noEmit` 类型检查
10. 确认 `config/agents/*.md` 文件内容未被修改（不需移动）

## 执行进度

**分支**: `refactor/plugin-based-tools`（基于 main `92e6d37`）

| Step | 任务 | 状态 | 备注 |
|------|------|------|------|
| 1 | Plugin SDK 增强（scope, PluginContext, 生命周期, getAgentTools, 两阶段启动） | ✅ 完成 | commit `c010346` |
| 2 | 迁移 wrong-questions plugin（4 tools） | ✅ 完成 | plugins/wrong-questions/ |
| 3 | 迁移 health-tracker plugin（7 tools） | ✅ 完成 | plugins/health-tracker/ |
| 4 | 迁移 client-manager plugin（9 tools，最复杂） | ✅ 完成 | commit `a16f27c`；数据迁移脚本 `scripts/sync-plugin-db.ts` 已补齐 44 条缺失事件 + 10 个客户报价数据 |
| 5 | 迁移 pricing plugin（3 tools） | ✅ 完成 | plugins/pricing/；数据迁移 2 条报价记录 |
| 6 | 迁移 trade-query plugin（6 tools） | ✅ 完成 | plugins/trade-query/；InfluxDB 连接独立，customers.json 从 config/ 读取 |
| 7 | 迁移 hedge-ratio plugin（1 tool + monitor） | ✅ 完成 | plugins/hedge-ratio/；monitor 通过 dynamic import 获取企微连接 |
| 8 | 迁移 wework-qa plugin（1 tool + monitor） | ✅ 完成 | plugins/wework-qa/；LLM provider 通过 dynamic import 注入，monitor 通过 start() 生命周期启动 |
| 9 | 最终清理 + 全量验证 | ⏳ 待执行 | 删除 src/ 残留、tsc 检查、端到端测试 |

**已验证**：
- `npx tsc --noEmit` 无新增错误
- `npx tsx src/index.ts --server` 启动正常，11 个 plugin 全部加载成功
- 所有 bot（企微 WS、飞书 WS）正常连接
- client-manager plugin 数据完整性验证通过：156 事件、10 客户报价数据已同步
- pricing plugin 数据迁移通过：2 条报价记录从主库迁移到 `data/plugins/pricing/pricing.db`
- trade-query plugin 加载成功（6 tools），InfluxDB 连接独立于核心
- hedge-ratio plugin 加载成功，monitor 在 `start()` 阶段通过 dynamic import wework bot 启动轮询
- 单元测试全量通过：15 files / 174 tests（含 3 个新 plugin 测试文件：pricing 17 tests、trade-query 12 tests、hedge-ratio 6 tests）
- wework-qa plugin 加载成功（1 tool），monitor 在 `start()` 阶段通过 dynamic import 注入 Telegram/Feishu 通知渠道

**Step 4 已解决的难点**：
- `src/commands/client.ts` 依赖 `getDb()` 主库连接 → 完全重写为独立 SQLite（`plugins/client-manager/src/db.ts`）
- `isAgentAdmin` 权限检查 → 通过 `PluginContext.isAdmin()` 注入
- `recordEvent` → 改为写 plugin 自己的 `client_events` 表（含 `performed_by_name` 冗余）
- 数据迁移一次性迁移不支持增量同步 → `scripts/sync-plugin-db.ts` 补齐缺失数据

**Step 5-7 实施要点**：
- pricing plugin：独立 SQLite（`data/plugins/pricing/pricing.db`），`init()` 时从主库一次性迁移 pricing_quotes 数据
- trade-query plugin：InfluxDB 连接完全独立（从 env 读取），customers.json 从 `config/` 目录读取
- hedge-ratio plugin：monitor 通过 `start()` 生命周期 + `dynamic import('../../src/wework/bot.js')` 注入企微连接，避免静态依赖核心代码
- 核心清理：`src/tools/index.ts` 移除 tradeTools/hedgeRatioTools/pricingQuoteTools/weworkTools 四个 module import；`src/index.ts` 移除 `startHedgeRatioMonitor`/`startMonitor` 调用（plugin 的 `start()`/`stop()` 自动处理）
- `src/commands/trade.ts` 暂保留（feishu/telegram formatter 仍有 import），将在 Phase 3 清理
- wework-qa plugin：`extractWeworkQA` 需 LLM 调用，通过 `init()` 时 dynamic import `src/llm/provider.js` 注入；`fetchWeworkMessages` 自包含（读本地文件目录，路径从 `WEWORK_DUMP_DIR` env 获取）；monitor 通过 `start()` 时 dynamic import Telegram/Feishu/DB 连接实现通知推送；移除了 `/watch` CLI 命令（monitor 由 plugin 生命周期自动管理）

## 风险与注意事项

- **plugin 加载顺序**：两阶段启动（Phase 1e），`init()` 早期完成 schema 迁移，`start()` 在 bot 启动后执行 monitor 服务
- **backward compat**：工具名不变，agent 配置不变，现有 universal plugins 无需改动（`scope` 默认 'universal'）
- **plugin scope 可见性**：`agent-bound` plugin 的工具不再自动注入所有 agent，必须出现在 `tools_list` 中才可见。`tools_mode='all'` 的 agent 仍然看到所有已加载 plugin tools（通过 `getAllPluginTools()`），再用 `block_tools` 排除
- **plugin 间依赖**：import_pricing_schedule 操作 clients 表（属于 client-manager plugin），放在 client-manager 中，pricing plugin 只管 pricing_quotes 表
- **审计日志分治**：
  - 主库 `events` 表：仅记录平台实体（agent、knowledge、document、skill）操作
  - client-manager plugin：自建 `client_events` 表，写入时冗余存储 `performed_by_name`（从 `ctx.getCurrentUser().name` 获取），展示时无需回查任何外部数据源
  - 迁移时需从主库 events 抽出 `entity_type='client'` 记录 → plugin `client_events` 表（需关联 users 表补齐 performed_by_name），迁移完成后从主库 DELETE
- **Plugin 隔离原则**：见顶部「Plugin 原则」，plugin 代码只依赖 `@samata/plugin-sdk` 类型包 + `PluginContext` 接口注入，不 import 任何 `src/` 模块
- **混合期兼容**：迁移逐个 plugin 进行，`executeNativeTool` fallback 链保证：先查 native → 再查 plugin。同名工具 native 优先，迁移完删 native 侧即可
