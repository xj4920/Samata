# Corporate Action Alert AM-only 配置简化

## 背景

美港日韩股公司行为提醒原设计包含 AM 与 PM 两个批次。业务确认不再需要晚上补跑批次，只保留每日早上一次，减少生产导出、FTP/SFTP 文件检查和缺失异常提醒的复杂度。

## 决策

- Samata 运行配置只保留早上窗口 `08:20-09:30`。
- 删除 `config/corporate-action-alert.json` 中的 `evening_window`。
- 插件仍保留 `batch` 字段兼容历史数据，但运行侧只期待 `corporate_action_alert_YYYYMMDD_AM.csv`。
- `otcclaw` 工具绑定不变；事件触发和定向推送郭晓瑜逻辑由插件实现。

## 改动清单

- `config/corporate-action-alert.json`
  - 删除 `schedule.evening_window`。
- `docs/plan/2026-06-10_corporate-action-alert-am-only.md`
  - 记录本次配置简化背景、决策和验证。

## 验证命令

```text
npx tsc --noEmit
```

## 验证结果

```text
npx tsc --noEmit
passed
```

## Commit Hash

651b7df42cbffeea5d5bf8527854aeeb8e2155a8
