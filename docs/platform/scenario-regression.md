# 场景回归评测

Samata 的场景回归评测用于在模型、Prompt、工具声明或 Agent loop 发生较大变化前后，
使用同一组真实场景检查行为是否退化。它与具体功能设计解耦，不以某一种 Agent
编排方式为前提。

## 基本原则

- 生产 telemetry 用于发现候选，不直接作为标准答案。
- case、工具 fixture、断言和 baseline 统一保存在 Git。
- 真实回答通过事实断言和语义 rubric 判断，不做全文快照比较。
- 默认使用真实模型和冻结工具结果；有副作用的工具不得在 frozen 模式执行。
- 未脱敏或未经人工审核的候选不得进入正式门禁。
- dirty 工作区产生的结果不得提升为 baseline。

## 数据流

```text
telemetry JSONL
  -> 脱敏、聚类和场景分类
  -> 本地候选报告
  -> 人工补齐 fixture / assertions / rubric
  -> approved case
  -> smoke / full 回放
  -> baseline 差异报告
```

现有 telemetry 中的用户问题最多保留 2000 字，回答最多保留 500 字，工具输出最多
保留 300 字预览。因此自动生成的 draft 必须保持 `telemetryIncomplete: true`，并在人工
审核时补齐完整工具证据。

## 用例结构

评测数据位于 `evals/`：

- `taxonomy.yaml`：主场景定义。
- `cases/`：经过审核的 YAML case。
- `fixtures/`：较大的冻结工具结果。
- `prompts/`：分类器和 Judge prompt。
- `gates.yaml`：门禁阈值。
- `baselines/`：去除回答正文和工具原文后的正式 baseline。

case 状态包括：

- `draft`：候选骨架，不进入正式门禁。
- `approved`：已脱敏并完成人工审核。
- `quarantined`：已知不稳定，暂不作为门禁。
- `deprecated`：只保留历史追溯。

## 候选抽取

```bash
npm run eval:extract -- \
  --from=2026-05-25 \
  --to=2026-06-18 \
  --limit=200 \
  --min-per-scenario=5
```

JSON 候选写入 `data/evaluation/candidates/`，Markdown 报告写入
`docs/report/scenario-evaluation/`；两者都属于本地生成物，不提交到 Git。

业务专有名词可以通过重复参数补充脱敏：

```bash
npm run eval:extract -- --redact-term='<term-1>' --redact-term='<term-2>'
```

从候选生成本地 draft：

```bash
npm run eval:drafts -- \
  --input=data/evaluation/candidates/latest.json \
  --per-scenario=3
```

draft 默认写入 `data/evaluation/draft-cases/`。审核人需要检查问题正文、完整工具结果、
必要事实、禁止结论、工具权限和语义 rubric，不能直接把自动生成文件改为 `approved`。

## 校验与运行

```bash
npm run eval:validate
npm run eval:self-test
npm run eval:smoke
npm run eval:full
```

- `eval:self-test` 不访问模型或业务系统，只验证评测基础设施。
- `eval:smoke` 每个场景选择一个 approved case，每个 case 执行一次。
- `eval:full` 执行全部 approved case，并遵循 case 中的重复次数。
- 没有 approved case 时，smoke/full 会显式失败，避免出现空测试误报成功。

场景运行器通过 fixture router 接管工具执行。未声明工具、参数不匹配和 fixture 用尽均
失败关闭；工具声明和 Agent loop 仍使用候选代码当前实现。

## baseline 与比较

完整运行会在 `data/evaluation/runs/` 生成 JSON 和 Markdown。本地完整结果可能含回答和
冻结证据，因此不提交。

```bash
npm run eval:compare -- \
  --baseline=evals/baselines/scenario-v1.json \
  --current=data/evaluation/runs/<run>.json

npm run eval:gate -- \
  --baseline=evals/baselines/scenario-v1.json \
  --current=data/evaluation/runs/<run>.json

npm run eval:promote-baseline -- \
  --run=data/evaluation/runs/<run>.json \
  --name=scenario-v1
```

提升 baseline 时会拒绝 dirty 工作区、失败 case 和不确定 case，并移除回答正文、工具
原文和断言实际值。baseline 更新必须经过人工审核。

## Langfuse 与 Phoenix

场景回归的本地 case、runner 和 gate 是权威实现。Langfuse 可以在本地闭环稳定后作为
实验展示 reporter，但不能成为唯一 baseline。当前不引入 Phoenix；只有现有 Langfuse
在真实使用中出现明确能力缺口时，才使用同一数据集做独立 PoC。
