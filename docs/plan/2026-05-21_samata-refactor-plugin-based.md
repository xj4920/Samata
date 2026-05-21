# Samata 项目重构：核心平台 + 独立工具插件

## Context

当前所有 agent 专属 tools、commands、DB schema 全部混在 `src/` 中，职责不清。需要将 otcclaw/doctor/tutor 等专属工具从核心平台剥离为独立的 plugin 模块（放在 `plugins/` 下），每个 plugin 管理自己的 tools、commands、SQLite DB 和配置文件。

**核心原则：**
- Agent 定义（DB 记录 + `config/agents/<name>.md`）保留在 Samata 核心
- Agent = COMMON_SET + 按名称引用的专属 tools（来自 plugins）
- 每个 plugin 独立可加载、独立 SQLite、互不影响

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
│   ├── db/schema.ts                  ← 仅平台表（users/agents/knowledge/skills/memory/reminders/todos/documents/bot_apps/events/telemetry_turn/scheduled_tasks/migrations）
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

**1a. `packages/plugin-sdk/src/types.ts`** — `PluginModule` 增加可选生命周期：

```ts
interface PluginModule {
  name: string;
  description?: string;
  toolDefinitions: ToolDefinition[];
  handleTool(name: string, input: any): Promise<string | null>;
  /** 初始化插件（含 schema 迁移） */
  init?(): Promise<void>;
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

**1b. `src/plugins/registry.ts`** — 加载时调用 `plugin.init?.()` 和 `plugin.start?.()`，关闭时调用 `plugin.stop?.()`：

```ts
// 在 loadPlugin 后:
if (plugin.init) await plugin.init();
if (plugin.start) await plugin.start();

// 在 stopPluginWatcher / gracefulShutdown 中:
for (const [, loaded] of loadedPlugins) {
  if (loaded.module.stop) await loaded.module.stop();
}
```

**1c. 无需改动** `src/llm/agent.ts` 的 `getGlobalTools()` — plugin tools 已通过 `getPluginTools()` 自动合并。

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

**2a. client-manager**（9 tools）
- tools: query_clients, view_client, get_client_history, add_client, update_client, advance_client, rollback_client, delete_client, import_pricing_schedule
- SQLite: `data/plugins/client-manager/client-manager.db` → clients 表
- Config: `plugins/client-manager/config/customers.json`
- 数据迁移：从主库 clients 表复制数据到插件 SQLite

**2b. trade-query**（6 tools）
- tools: query_trades, trade_summary, plot_trades, list_customers, export_trades_csv, export_north_info_csv
- DB: 复用 InfluxDB 连接（无 SQLite）
- Config: `plugins/trade-query/config/trading-calendar-sse.json`

**2c. pricing**（3+1 tools）
- tools: import_pricing_quote, query_pricing_quote, list_pricing_quote_dates, import_pricing_schedule（注：import_pricing_schedule 属于 client 域但操作 clients 表，实际放 client-manager）
- SQLite: `data/plugins/pricing/pricing.db` → pricing_quotes 表

**2d. hedge-ratio**（1 tool）
- tools: query_hedge_short
- 后台服务: hedge-ratio-monitor（定时检查对冲比并通过企微推送）

**2e. wework-qa**（1 tool）
- tools: extract_wework_qa
- 后台服务: wework-monitor（监听企微消息自动提取 QA）

**2f. health-tracker**（7 tools）
- tools: add_health_record, query_health_records, health_summary, log_sleep, log_meal, log_symptom, set_medication_reminder
- SQLite: `data/plugins/health-tracker/health-tracker.db` → health_records + health_files 表

**2g. wrong-questions**（4 tools）
- tools: record_wrong_question, list_wrong_questions, mark_wrong_question_mastered, wrong_question_report
- SQLite: `data/plugins/wrong-questions/wrong-questions.db` → wrong_questions + wrong_question_assets 表

### Phase 3: 清理核心 Samata

**3a. `src/tools/index.ts`** — 移除 7 个已迁移 module import（client, trade, pricing-quote, hedge-ratio, wework, health, wrong-question），仅保留 COMMON_SET 对应的 23 个 module。

**3b. `src/commands/`** — 删除已迁移的 command 文件。

**3c. `src/db/schema.ts`** — 移除 clients / pricing_quotes / health_records / health_files / wrong_questions / wrong_question_assets 表定义及相关 migration。保留 `events` 表（平台级审计日志）。

**3d. `src/models/`** — 移除 `client.ts`、`event.ts`（如仅被迁移的 commands 使用）。

**3e. `src/services/`** — 移除 `wework-monitor.ts`、`hedge-ratio-monitor.ts`（已迁移到对应 plugin）。

**3f. `src/index.ts`** — 移除 `startMonitor()`、`startHedgeRatioMonitor()` 调用（plugin 的 `start()` 生命周期自动处理）。

**3g. `config/`** — 移动 `customers.json`、`trading-calendar-sse.json` 到对应 plugin；agent md 文件保持不变。

**3h. `extensions/`** — 删除 `otc-claw/`、`personal/`（已迁移到 plugins），`wiki-sync/` 迁移到 `plugins/wiki-sync/`。

### Phase 4: Agent 配置不变

Agent 的 `tools_list` 中引用的工具名不变（如 `query_clients`、`add_health_record`），只是这些工具的加载来源从 `src/tools/` 变为 `plugins/<xxx>/`。

`getAgentTools()` 在 `standard` 模式下自动合并 `COMMON_SET + tools_list + pluginTools + mcpTools`，无需任何改动。

`AGENT_EXCLUSIVE_TOOLS`（wrong_question 系列专属 tutor）可简化——因为插件工具通过 agent 的 `tools_list` 控制可见性，其他 agent 不加这些工具名即可。

### Phase 5: `config/agents/` 文件不变

所有 agent prompt md 文件保留在 `config/agents/` 下，不随 plugin 移动。agent 定义（name, display_name, tools_mode, tools_list 等）仍由核心 DB 管理。

## 工具归属总结

| Plugin | Tools | 独立 SQLite |
|--------|-------|------------|
| client-manager | query_clients, view_client, get_client_history, add_client, update_client, advance_client, rollback_client, delete_client, import_pricing_schedule | clients |
| trade-query | query_trades, trade_summary, plot_trades, list_customers, export_trades_csv, export_north_info_csv | 无（InfluxDB） |
| pricing | import_pricing_quote, query_pricing_quote, list_pricing_quote_dates | pricing_quotes |
| hedge-ratio | query_hedge_short | 无 |
| wework-qa | extract_wework_qa | 无 |
| health-tracker | add_health_record, query_health_records, health_summary, log_sleep, log_meal, log_symptom, set_medication_reminder | health_records, health_files |
| wrong-questions | record_wrong_question, list_wrong_questions, mark_wrong_question_mastered, wrong_question_report | wrong_questions, wrong_question_assets |
| *(保留在 core)* | 其余所有 COMMON_SET tools | *(主库)* |

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

## 风险与注意事项

- **plugin 加载顺序**：`initPlugins()` 在 `src/index.ts` 中已有调用，位置合适，无需改动
- **backward compat**：工具名不变，agent 配置不变，DB migration id 保留（但内容清空）
- **monitor 服务**：wework-monitor 和 hedge-ratio-monitor 从 `src/index.ts` 的显式调用改为 plugin 生命周期自动启动，时序上要确保企微 bot 启动后再初始化这些 plugin（当前 `initPlugins()` 在 `startAllWeworkBots()` 之前，需要调整顺序或将 monitor 的 start 延迟）
- **plugin 间依赖**：import_pricing_schedule 操作 clients 表（属于 client-manager plugin），需要 pricing plugin 能访问 client-manager 的 DB。方案：import_pricing_schedule 放在 client-manager plugin 中（操作自身 DB），pricing plugin 只管理 pricing_quotes 表
- **events 表**：client 操作的事件记录在平台级 events 表，client-manager plugin 写事件时仍写入主库（通过 core 提供的 helper），或 plugin 自建 events 表
