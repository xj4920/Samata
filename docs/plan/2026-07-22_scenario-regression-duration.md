---
docModules:
  - platform
docTopics:
  platform: 场景回归评测
canonicalDocs:
  - /platform/scenario-regression
status: implemented
---

# 场景回归耗时统计修复

## 背景

场景回归报告中的耗时中位数出现大额负数。Case 为保证业务时间确定性会调用
`vi.setSystemTime(fixedTime)`，但 runtime 在冻结时间前使用真实 `Date.now()` 记录开始时间，
结束时再使用已经冻结到历史日期的 `Date.now()`，导致两个不同时间域相减。

## 核心决策

- 业务时间继续使用 `Date.now()` 和 `vi.setSystemTime()`，确保模型和工具看到固定日期。
- 性能耗时改用 `node:perf_hooks` 的单调时钟 `performance.now()`，不受系统时间调整影响。
- 最终耗时四舍五入为整数毫秒，保持报告和现有类型的数据格式稳定。
- 不在报告层把负数截断为零，避免掩盖 runtime 上游的计时错误。

## 改动清单

- `tests/scenario/helpers/scenario-runtime.ts`：使用单调时钟计算场景执行耗时。
- `tests/unit/evaluation/scenario-runtime.test.ts`：冻结历史时间时断言耗时非负且低于超时预算。
- 重跑 Smoke 和 Full，确认报告耗时中位数恢复为合理正数。

## 数据流

```text
Case fixedTime -> Date.now() 业务时间冻结
真实场景执行 -> performance.now() 单调耗时
             -> repetition.metrics.durationMs
             -> case 耗时中位数
             -> JSON / Markdown 报告
```

## 验证命令

- `bash scripts/test.sh tests/unit/evaluation/scenario-runtime.test.ts`
- `npm run eval:self-test`
- `npx tsc --noEmit`
- `npm run eval:smoke`
- `npm run eval:full`
- `npm run eval:validate`
- `npx vitepress build docs`
- `git diff --check`

## 验证结果

- 场景 runtime 定向单测通过：冻结业务日期仍为 `2026-07-21`，耗时非负且低于超时预算。
- `eval:self-test` 通过：8 个测试文件、18 个测试。
- `npx tsc --noEmit` 通过。
- `eval:validate` 通过：9 个 approved case，case set hash 为
  `861f8d9537d9f0ffe056de4abd198d5d6faeb50e92ee97eb18444b605042046a`。
- Smoke 中成功场景耗时恢复为 3.643～19.854 秒；Web 场景首次运行遇到 Provider
  并行 `tool_use` 缺少紧邻 `tool_result` 的 400，定向重跑通过。
- Full Run ID `c602310b-1106-49f9-89c6-bf61ec20d210`：8/9 case 通过；成功完成的
  25 次 repetition 耗时全部为正，范围 2.948～23.676 秒，8 个完整场景的耗时中位数为
  3.616～14.329 秒。
- Full 中 Web 场景另外两次触发同一 Provider 400，属于场景回归发现的独立 Agent
  并行工具消息配对问题；本次不修改 Agent loop，避免扩大修复范围。
- `npx vitepress build docs` 与 `git diff --check` 通过。

## 构建与运行影响

- 只影响测试评测 runtime，不修改生产 Agent loop、工具或数据库 schema。
- 不需要构建 Docker image、执行数据库迁移或重启服务。

## Commit Hash

- 实现提交：待用户确认提交后回填。
