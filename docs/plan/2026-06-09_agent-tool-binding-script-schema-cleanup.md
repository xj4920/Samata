---
docModules:
  - plugins
  - permissions
docTopics:
  plugins: Agent 绑定
  permissions: 工具权限
status: implemented
canonicalDocs:
  - /plugins/bind-to-agent
  - /permissions/tool-access
---

# Agent-Tools 幂等绑定脚本与 Schema 清理

## 背景

Samata 的 agent-bound plugin 工具可见性由 `agents.tools_list` / `block_tools` / `user_tools_list` 决定。历史上部分 work plugin 工具通过 `src/db/schema.ts` 的 `runOnce` migration 自动写入 `otcclaw`，同时还有业务定时任务 seed。这让平台代码承载了 work 仓库的业务工具名，不利于 Samata 平台与 work plugin 解耦。

## 决策

- Agent 与工具绑定改为运行时 DB 配置，由 CLI/system-admin 语义下的绑定脚本调用 `saveAgent()` 完成。
- `src/db/schema.ts` 不再新增或保留 work/business plugin 工具绑定 seed、成员 blocklist 修正 seed、业务定时任务 seed。
- work plugin 不声明 agent binding；具体工具名通过管理员命令行参数或本地忽略配置提供。
- 不删除现有运行库中的 `agents` / `scheduled_tasks` 数据；已部署环境现有记录继续保留。

## 改动清单

- 新增 `src/llm/agents/tool-binding.ts`：提供幂等的 `applyAgentToolBinding()`，合并数组后走 `saveAgent()`。
- 新增 `scripts/bind-agent-tools.ts`：支持 `--agent`、`--add`、`--remove`、`--block`、`--member-block`、`--dry-run`、`--json` 和本地 JSON 批量配置。
- 更新 `.gitignore`：忽略 `config/agent-tool-bindings*.json`。
- 清理 `src/db/schema.ts`：移除 work tool 绑定/修正 runOnce、业务 tool_call scheduled task seed、`CronExpressionParser` import，并取消 admin/alter-ego 对 work 工具的硬编码 blocklist。
- 更新插件绑定与权限文档：标准方式改为运行绑定脚本，不再建议写 schema migration。
- 更新单测：新增绑定 helper 单测，调整 schema / agent config / schedule 测试为显式绑定后再验证 work 工具场景。

## 验证命令

已执行：

```text
npm run docs:plan-sync
npm run test:unit -- tests/unit/config/agent-tool-binding.test.ts
npm run test:unit -- tests/unit/schema/schema.test.ts tests/unit/config/agent-config.test.ts tests/unit/tools/schedule.test.ts
rg -n "sync_normal_trading_summary|sync_fast_trading_summary|calc_etf_trades|query_clients" src/db/schema.ts
git diff --check
npx tsx scripts/bind-agent-tools.ts --help
```

## 验证结果

- `npm run docs:plan-sync` 通过并更新 plan index；输出中仍有既有历史 plan 缺少 frontmatter 的提示，本次新增文件未被点名。
- `npm run test:unit -- tests/unit/config/agent-tool-binding.test.ts` 通过：1 个测试文件，4 个测试。
- `npm run test:unit -- tests/unit/schema/schema.test.ts tests/unit/config/agent-config.test.ts tests/unit/tools/schedule.test.ts` 与新增测试组合通过：4 个测试文件，75 个测试。
- `rg -n "sync_normal_trading_summary|sync_fast_trading_summary|calc_etf_trades|query_clients" src/db/schema.ts` 无匹配，确认 schema 不再引用这些业务工具名。
- `git diff --check` 通过。
- `npx tsx scripts/bind-agent-tools.ts --help` 通过，脚本参数帮助可正常输出。

## Commit Hash

- 待提交后回填。

## 构建与运行影响

- 影响启动期 schema 行为和运维配置方式；部署到运行环境后需要重新构建或发布 runtime / Docker image，并重启服务。
- 不新增 npm 依赖。
- 不修改当前 `data/samata.db`；新环境如需 work 工具绑定和业务定时任务，需要管理员运行绑定脚本或手动创建定时任务。
