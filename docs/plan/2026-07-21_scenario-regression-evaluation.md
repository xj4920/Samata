---
docModules:
  - platform
docTopics:
  platform: 场景回归评测
canonicalDocs:
  - /platform/scenario-regression
  - /platform/observability
status: implementing
---

# Samata 场景回归评测体系

## 背景

Samata 后续会持续进行 Agent runtime、Prompt、工具调度和模型相关的大改动。当前单元
测试可以验证确定性代码，但缺少一套基于真实用户场景的行为基线，无法稳定回答“改动后
既有能力是否退化”。

本次先建设与任何未来功能无关的场景回归能力。只有回归数据集、回放器和 baseline
稳定后，才进入后续大型功能开发。

## 核心决策

- telemetry 只用于发现候选；历史回答和工具预览不直接作为标准答案。
- case、fixture、rubric、gate 和 baseline 以 Git 为权威来源。
- 场景按用户意图分类；失败、空结果、权限、多轮和副作用作为横向标签。
- 默认使用真实模型和冻结工具结果，未声明工具失败关闭。
- 硬断言优先于语义 Judge；Judge 高分不能覆盖权限、工具或事实硬断言失败。
- 完整运行结果保存在忽略目录，正式 baseline 去除回答正文和工具原文。
- dirty 工作区结果不得提升为 baseline。
- 第一阶段不引入 Phoenix；Langfuse 仅作为后续可选 reporter。
- 不扩大生产 Langfuse 正文采集，不修改数据库 schema，不写入运行时 memory。

## 数据流

```text
telemetry JSONL
  -> redaction / fingerprint / classification
  -> local candidate report
  -> human review
  -> approved YAML case + frozen tool fixture
  -> current runAgenticChat + fixture router
  -> hard assertions + optional judge
  -> run manifest
  -> baseline comparison / gate / optional Langfuse reporter
```

## 改动清单

- `evals/`
  - 新增 taxonomy、gate、分类和 Judge prompt、case/fixture/baseline 目录。
- `src/evaluation/`
  - 新增 case 类型与校验、telemetry 读取、脱敏、匹配器、fixture router、硬断言、
    Judge、runner、报告和 baseline 对比。
- `scripts/evaluation/`
  - 新增候选抽取、本地 draft 生成、case 校验、结果比较和 baseline 提升命令。
- `tests/unit/evaluation/`
  - 覆盖 schema、脱敏、候选读取、fixture、runner 和 baseline 比较。
- `tests/scenario/`、`vitest.scenario.config.ts`
  - 新增真实模型 + 冻结工具的场景执行入口；没有 approved case 时显式失败。
- `package.json`
  - 新增 `eval:*` 命令。
- `docs/platform/scenario-regression.md`
  - 新增操作、数据安全和门禁说明。
- `docs/platform/observability.md`、`docs/platform/index.md`
  - 关联运行观测与场景回归文档。

## 首轮候选结果

- 输入范围：`2026-05-25` 至 `2026-06-18` 的本地 telemetry JSONL。
- 读取 turn：403。
- 损坏 JSON 行：0。
- 去重候选上限：200。
- 平衡采样保证每个有足够数据的场景至少保留 5 个候选，避免高频复杂请求挤占全部名额。
- 本地 draft：27 个，覆盖 9 个场景，每个场景 3 个候选。
- draft 仍包含不完整 telemetry preview，只保存在忽略目录，尚未进入正式数据集。

## 验证命令

- 已执行：`git pull --ff-only`，结果为“已经是最新的”。
- 已执行：`npx tsc --noEmit`。
- 已执行：`npm run eval:self-test`，8 个文件、18 个测试通过，其中包含当前
  `runAgenticChat()` + Mock Provider + 冻结工具 fixture 的集成自检。
- 已执行：`npm run eval:extract -- --from=2026-05-25 --to=2026-06-18 --limit=200`。
- 已执行：`npm run eval:drafts -- --input=data/evaluation/candidates/latest.json --per-scenario=3`。
- 已执行：`npm test`，46 个测试文件、255 个测试通过。
- 已执行：`npx vitepress build docs`，文档构建成功；仅有既有语法高亮与 chunk size 警告。
- 已执行：`git diff --check`，通过。
- 已执行预期失败门禁：`npm run eval:smoke` 返回退出码 1，原因是当前尚无人工审核的
  approved case，符合防止空数据集误报成功的设计。

## 构建与运行影响

- 不修改生产 Agent loop、工具业务实现、数据库 schema 或 Docker 配置。
- 新增源码仅由评测脚本和测试入口导入，不进入生产启动数据流。
- 不新增第三方依赖，不需要数据库迁移、Docker image 重建或服务重启。

## Commit Hash

- 实现提交：`41e5632a909c3e7bc44d6055a2d6faf263bdf5d4`。
