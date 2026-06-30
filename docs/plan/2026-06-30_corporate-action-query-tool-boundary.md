---
docModules:
  - plugins
  - external-data
docTopics:
  plugins: 插件机制
  external-data: 公司行为提醒
status: implemented
canonicalDocs:
  - /platform/channels-and-sessions
---

# 公司行为提醒定时任务边界对齐

## 背景

公司行为提醒插件将删除 `check_corporate_action_alerts` 对外工具，改为由 `sync_corporate_action_alerts` 负责同步落库、`query_corporate_action_alerts alertable_only=true` 负责查询可提醒事件。Samata 主仓仍有 prompt、bootstrap 示例和运行配置引用固定通知目标，需要同步移除，避免 Agent 继续调用已删除工具或依赖不存在的 `otcclaw-bot`。

## 决策

- Otcclaw 提示词明确：定时提醒由 Samata 定时任务负责推送，插件不决定收件人。
- 生产 bootstrap 示例从工具列表和普通用户 blocklist 中移除 `check_corporate_action_alerts`。
- `config/corporate-action-alert.json` 移除 `notification` 段，只保留 SFTP 与同步窗口配置。

## 改动清单

- `config/agents/otcclaw.md`：改写公司行为提醒规则为 `sync + query(alertable_only=true) + 当前任务 channel 汇总回复`。
- `config/production-bootstrap.example.json`：移除 `check_corporate_action_alerts`。
- `config/corporate-action-alert.json`：移除固定 `wework:otcclaw-bot` / `wework_guoxiaoyu` 通知配置。

## 验证命令

- `rg -n "check_corporate_action_alerts|wework:otcclaw-bot|wework_guoxiaoyu" config README.md src`
- `git diff --check -- config/agents/otcclaw.md config/production-bootstrap.example.json config/corporate-action-alert.json docs/plan/2026-06-30_corporate-action-query-tool-boundary.md package.json package-lock.json`

## Commit

- commit hash：待提交
