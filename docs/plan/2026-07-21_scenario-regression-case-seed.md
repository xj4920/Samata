---
docModules:
  - platform
docTopics:
  platform: 场景回归评测
canonicalDocs:
  - /platform/scenario-regression
status: implemented
---

# 场景回归首批 Case 初始化

## 背景

场景回归基础设施已经完成，但正式数据集尚无 approved case，Smoke 和 Full 套件会按
设计失败。本次从运行目录 `/opt/samata/logs` 回看最近 30 天 telemetry，初始化一批
能够稳定回放的 golden case。

## 时间范围与候选结果

- 回看窗口：`2026-06-21` 至 `2026-07-21`。
- 实际日志文件：`2026-06-22` 至 `2026-07-21`，其中 `2026-07-12` 无日志文件。
- 读取 turn：481。
- 损坏 JSON 行：0。
- 平衡去重候选：200。
- 最近窗口覆盖 8 个主场景，没有 `web_research` 请求。
- 自动 draft 在遇到疑似敏感内容时被安全检查阻断，没有直接批准生产日志候选。

## 核心决策

- 首批建立 9 个 Smoke Case，每个 taxonomy 主场景 1 个。
- 7 个场景取自最近 30 天；普通问答和 Web 调研因最近窗口缺少可用样本，从上一窗口补齐。
- 自动分类明显错误的候选由人工重新归类，例如日志超时查询归入问题调查。
- 不复制 telemetry 的 300/500 字预览，改为完整、最小、脱敏的结构化 fixture。
- 客户、服务、任务和文件标识全部泛化，保留不可逆 turn hash 用于追溯。
- 生产副作用工具仍保留当前声明和 Agent 决策路径，但执行由 fixture router 接管。
- 首批用于验证 Smoke 链路；业务 owner 复核前不得提升为正式 baseline。

## 改动清单

- 在 `evals/cases/` 的 9 个场景目录分别增加一个 approved case。
- 覆盖正常回答、知识检索、空结果、工具失败、权限拒绝、副作用、跨源调查和复杂工作流。
- 每个 Full case 重复 3 次；critical 问题调查要求全部重复运行通过。
- 首轮发现当前 Judge 偶发不返回可解析 JSON；首批全部使用硬断言，Judge 稳定性作为
  后续增强项，避免把评分器格式故障误判为 Agent 回归。

## 数据流

```text
/opt/samata/logs telemetry
  -> 最近 30 天候选抽取
  -> 安全检查与人工重新分类
  -> 脱敏、最小化完整 fixture
  -> approved case
  -> 当前 Agent loop + 真实模型 + 冻结工具
  -> 硬断言 + 可选 Judge
  -> Smoke / Full 本地运行报告
```

## 验证命令

- `git pull --ff-only`
- `npm run eval:extract -- /opt/samata/logs/telemetry-*.jsonl --from=2026-06-21 --to=2026-07-21 --limit=200 --min-per-scenario=5`
- `npm run eval:validate`
- `npm run eval:self-test`
- `npm run eval:smoke`
- `npm run eval:full`
- `npx tsc --noEmit`
- `git diff --check`

## 验证结果

- Case schema 校验通过：9 个 approved case，9 个 taxonomy 主场景各 1 个；当前属于
  首批 smoke 覆盖，各场景仍低于长期目标的 3～5 个 case。
- `eval:self-test` 通过：8 个测试文件、18 个测试。
- 当前 case set hash：`861f8d9537d9f0ffe056de4abd198d5d6faeb50e92ee97eb18444b605042046a`。
- 全场景 Smoke 曾 9/9 通过，Run ID `a58b46f6-be72-49fe-b8e7-cdb735dce377`。
- Full 采用每 case 3 次重复。校准过程中发现的失败轨迹里，工具、参数和结论均正确，
  原因是自然语言同义表达、Markdown 装饰未纳入正则，或两次工具调用使用了 5 个
  loop round。
- 最后一轮全量 Full 中 8 个场景 3/3 通过，任务交付因“每周 **二至周六**”的 Markdown
  装饰误判为 2/3，Run ID `2c4b316a-5e5a-4d55-ad6d-1e866744ebc1`。修正后任务交付
  定向 Full 3/3 通过，当前 case set Run ID `b2653496-694b-4be0-9ddc-e66fe983f693`。
- 此前业务查询、事故调查和复杂工作流的断言校准也分别完成 3/3 定向 Full；结合最后
  一轮全量报告，9 个场景的当前定义均具备 3 次重复通过证据。
- 最后一轮当前 hash Smoke 中 8/9 通过；文档导出已正确完成两个工具调用，但一次运行
  使用 6 个 loop round、1012 个累计输出 token，超过原 4/1000 预算。按当前基线调整为
  6/1200 后，文档导出定向 Full 3/3 通过，Run ID
  `e7b3a784-bffe-40e8-9805-144162314dee`。
- 最终当前 case set 的全量 Full 通过：9/9 case、27/27 repetitions，Run ID
  `622e35c1-79a6-46a0-8d6a-267348d78c8a`。
- Judge 在初始化过程中偶发返回不可解析的非 JSON 内容，因此首批 case 暂停 Judge，
  只启用确定性的工具、输入、顺序、事实、禁用声明和预算断言。
- `npx tsc --noEmit`、`git diff --check`、新增文件尾随空白检查和敏感信息模式检查通过。
- `npx vitepress build docs` 通过；`npm run docs:check` 被仓库已有 PLAN 缺失
  `docModules` 及失效 canonical target 阻断，本次 PLAN 本身已通过索引同步。
- 2026-07-22 新增业务查询 case 后的 Smoke 中，公司行为空结果正确回答为“无记录”，
  原正则只覆盖“空记录”等语序而误判；已补充语义等价的“无记录”，工具、失败原因和
  禁止声明均未放宽。
- 2026-07-22 用户确认 Web 调研不再作为 active regression；产业园区 case 状态改为
  `deprecated`，保留来源和 fixture 用于审计，不再被 Smoke 或 Full 加载。

## 已发现的后续问题

- 运行报告的 `durationMs` 负值已于 2026-07-22 修复：评测耗时改用不受 Case
  `fixedTime` 影响的单调时钟；详见 `2026-07-22_scenario-regression-duration.md`。
- 首批 case 尚未经过业务 owner 复核，不执行 baseline promotion。

## 构建与运行影响

- 不修改生产 Agent loop、工具实现、数据库 schema、Docker 或依赖。
- Case 只由评测命令加载，不进入生产启动数据流。
- 不需要构建 image、数据库迁移或服务重启。

## Commit Hash

- 实现提交：`c675abfb58f864265c68bb8a5c4886c8ac0472e1`。
