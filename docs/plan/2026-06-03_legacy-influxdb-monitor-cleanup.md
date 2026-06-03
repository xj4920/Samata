---
docModules:
  - platform
  - external-data
docTopics:
  platform: 插件生命周期与平台边界
  external-data: 交易数据源迁移
canonicalDocs:
  - /platform/architecture
  - /external-data/pricing-and-trade
status: implemented
---

# 旧 InfluxDB 监控与 north_info 迁移脚本清理

## 背景

OTC 交易查询、北向极速 `north_info` 兼容导出、FastTrading summary、套保比例查询已经切到 PostgreSQL。`messages.wework` 企微消息监控也已由外置 `wework-qa` 插件生命周期承接，主仓里的旧 `src/services/wework-monitor.ts` 不再有实际 import/handler 调用链。

此前主仓仍保留三类历史入口：

- 旧企微消息监控实现：`src/services/wework-monitor.ts`
- 旧 InfluxDB raw query helper：`src/db/influxdb.ts`
- 已完成验收的 `north_info -> samata_fast_trading_*` 一次性迁移脚本：`scripts/sync-influx-north-info-to-fast-postgres.mjs`

这些入口容易误导后续维护者继续配置或调用远程 InfluxDB，因此进行清理。

## 决策

- 主仓不再保留任何 InfluxDB 查询代码。
- `export_north_info_csv` 作为兼容工具名继续保留，但只代表 PostgreSQL-backed FastTrading summary 导出。
- `config/monitor.json` / `config/monitor.json.example` 暂时保留小写 `influx` 配置块，因为外置 `wework-qa` 插件仍可能读取这份配置。
- 不删除企微 Bot 长连接代码；本次只删除“按发送人/关键词轮询 InfluxDB 并推送通知”的旧监控实现。
- 已完成的 `north_info` 历史迁移脚本从主仓删除，避免未来误跑旧数据源。

## 改动清单

提交：`8f50d22 Remove legacy InfluxDB monitor code`

- 删除 `src/services/wework-monitor.ts`。
- 删除 `src/db/influxdb.ts`。
- 删除 `scripts/sync-influx-north-info-to-fast-postgres.mjs`。
- 更新 `config/agents/alter-ego.md`：企微消息监听改为外置插件后台服务口径，不再列 `wework_monitor`。
- 更新 `src/db/schema.ts`：
  - 默认 alter-ego tools 不再 seed `wework_monitor`。
  - 新增 `remove-legacy-wework-message-monitor-tool-v1`，从已有 agent 的 `tools_list` / `user_tools_list` 中移除旧工具名。
- 更新 `README.md` / `.env.example` / `docs/permission-system.md`：
  - 移除主仓 InfluxDB 环境变量说明。
  - 移除 `/watch` 旧命令说明。
  - 移除项目结构中 `wework-monitor` 服务描述。

## 验证

- `npx tsc --noEmit`
- `npx vitest run tests/unit/config/agent-config.test.ts tests/unit/schema/schema.test.ts tests/unit/tools/schedule.test.ts`
- 审计搜索：
  - `Influx|INFLUX|influxdb|queryInflux|writeInflux|sync-influx-north-info|wework-monitor|wework_monitor|startMonitor|stopMonitor|isMonitorRunning|/watch` 无代码命中。
  - 小写 `influx` 仅剩 `config/monitor.json` / `config/monitor.json.example`，作为外置插件配置保留。

## 留档规范

后续每次代码改动都需要同步生成或更新 `docs/plan/YYYY-MM-DD_topic.md`，记录背景、决策、改动清单、验证命令和提交信息；完成后将长期有效的工作规则或关键决策写入 memory。
