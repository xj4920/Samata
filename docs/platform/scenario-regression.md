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
- frozen、staging Contract 与 production Canary 使用独立目录和命令，不能混跑。

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

完整回归分三层：

```text
Frozen：approved case -> fixture router -> current Agent -> hard assertions
Contract：staging guard -> direct live tool -> structure/invariant assertions
Canary：production guard -> live Agent + tool allowlist -> answer/trace assertions
```

Frozen 回答“修改后 Agent 在固定证据上是否仍按预期工作”；Contract 回答“真实工具接口、
权限和依赖是否可用”；Canary 回答“生产专用身份下的端到端链路是否可用”。三者不能
相互替代。

现有 telemetry 中的用户问题最多保留 2000 字，回答最多保留 500 字，工具输出最多
保留 300 字预览。因此自动生成的 draft 必须保持 `telemetryIncomplete: true`，并在人工
审核时补齐完整工具证据。

## 用例结构

评测数据位于 `evals/`：

- `taxonomy.yaml`：主场景定义。
- `cases/`：经过审核的 YAML case。
- `contracts/`：staging 真实工具契约。
- `canary/`：production 真实 Agent Canary。
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

## staging 工具契约

Contract 不调用 LLM，而是使用与生产 Agent 相同的工具注册表和执行入口，按 YAML
顺序直接调用真实工具。后续步骤可通过
`{{steps.<step-id>.<path>}}` 引用前一步输出；动态 seed 使用 `${ENV_NAME}` 注入。
断言只支持受控的路径、类型、等值、包含、正则、数值关系、比率和日期顺序，不执行
任意 JavaScript。

```bash
npm run eval:contract:validate
npm run eval:contract -- --dry-run

EVAL_TARGET=staging \
EVAL_USER_ID='<dedicated-user>' \
EVAL_AGENT_ID='<dedicated-agent>' \
EVAL_KB_MARKER='<seed-marker>' \
npm run eval:contract -- --case=contract-knowledge-search-v1
```

默认只运行 `approved`；使用 `--include-draft` 才加载 draft。live 前必须满足：

- 目标严格为 staging。
- 用户和 Agent 在数据库中精确存在。
- 工具已注册，且专用 Agent 的有效权限包含该工具。
- case 所有环境变量均已配置。
- 工具已登记在 live 安全策略，未知或越级工具失败关闭。

首批知识库契约覆盖精确 marker 检索、空结果、搜索后全文读取和跨 Agent 文档权限
拒绝。marker 文档应是无敏感信息、可重复初始化的 staging seed；不固定相关性分数
和严格排序。

## production Canary

Canary 使用真实 provider、真实 Agent 和真实工具，但模型只能看到 case
`allowedTools` 与该 Agent 实际权限的交集。报告只保留回答/工具输入输出 hash、结构
摘要、耗时和断言结果，不保存完整生产正文。

```bash
npm run eval:canary:validate
npm run eval:canary -- --dry-run

EVAL_TARGET=production \
ALLOW_PROD_CANARY=1 \
CANARY_USER_ID='<dedicated-user>' \
CANARY_AGENT_ID='<dedicated-agent>' \
CANARY_CHANNEL='<feishu-or-telegram>' \
CANARY_TARGET_ID='<dedicated-target>' \
CANARY_KB_MARKER='<seed-marker>' \
npm run eval:canary -- --case=canary-knowledge-search-v1
```

Canary 默认每 case 只执行一次，schema 最多允许三次，避免把 frozen 回归的稳定性采样
策略机械套到生产。第一批 approved Canary 只读；带 SFTP、LogYi 或其他外部依赖的
场景在 live 验证前保持 draft。`controlled_delivery` 会真实发送文件或图片，只能使用
专用目标；独立 CLI 无法构造企微 WebSocket 上下文。

## 报告和门禁

Contract/Canary 报告写入 `data/evaluation/runs/`，JSON 用于 CI，Markdown 用于人工
复核。任一 case 出现 `failed` 或 `error` 时命令以非零状态退出，可直接作为部署门禁；
dry-run 的 `inconclusive` 只表示未执行，不能视为 live 通过。

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
