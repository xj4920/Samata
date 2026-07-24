---
docModules:
  - platform
docTopics:
  platform: 场景回归评测
canonicalDocs:
  - /platform/scenario-regression
status: ready_for_review
---

# Contract / Production Canary 场景回归评测

## 基本信息

- 日期：2026-07-23
- 分支：`codex/eval-contract-canary`
- 隔离工作树：`/home/xj/work/source/samata-eval-contract-canary`
- 基线提交：`82305a2098e0fe9f1db723c79722da79606b04e7`
- 状态：`ready_for_review`
- 实现提交：待用户确认后提交

## 背景

现有 `eval:smoke` / `eval:full` 使用冻结工具 fixture 回放真实场景，能够验证当前
Agent 在固定证据下是否仍会选择正确工具、传入正确参数并生成符合断言的回答，但不能证明：

1. staging 中的真实工具注册、权限、依赖和返回结构仍然可用；
2. production 中的真实 provider、Agent、工具权限和端到端链路仍然可用；
3. 带外部依赖或投递副作用的工具是否被安全地隔离和显式授权。

本次新增独立的 staging Tool Contract 和 production Canary 两层评测。它们与 frozen
场景回归分目录、分命令、分报告，且不改变 `npm run eval:full` 的 case 加载范围。
第一批 live 工具必须包含知识库检索，并覆盖搜索、全文读取、空结果和文档所有权边界。

## 核心设计

### 三层回归职责

```text
Frozen case
  -> fixture router
  -> current Agent loop
  -> hard assertions / judge

Staging Contract
  -> staging guard
  -> 专用 user + Agent 的有效工具权限
  -> direct executeTool
  -> 结构 / 类型 / 值 / invariant 断言

Production Canary
  -> production 双开关与专用身份 guard
  -> case allowedTools ∩ Agent 实际权限
  -> runAgenticChat + real provider/tools
  -> 工具轨迹 / 回答边界断言
```

- Frozen 回答“代码改动后，在固定证据上是否仍按预期工作”。
- Contract 回答“真实工具接口、权限与依赖在 staging 是否可用”。
- Canary 回答“生产专用身份下的端到端链路是否可用”。
- 三层结果不能互相替代；dry-run 只能证明配置和安全门禁可解析，不能算真实链路通过。

### Case 与执行策略

- `evals/contracts/**`：目标固定为 `staging`，默认只运行 `approved`。
- `evals/canary/**`：目标固定为 `production`，默认只运行 `approved`。
- `--include-draft` 才加载 draft；`--case=<id>` 可收窄到单一 case。
- Contract 不调用 LLM，按 YAML 顺序直接执行工具；后续步骤可引用前序输出。
- Canary 调用真实 Agent，但模型只能看见 case allowlist 与 Agent 有效权限的交集。
- production Canary 每个 case 默认执行 1 次，schema 上限 3 次，避免扩大生产调用。
- 有外部依赖、生产数据不稳定或真实投递副作用的 case 先保持 draft。

### 安全与数据保护

- 未登记到 live 安全策略的工具失败关闭。
- 安全等级为 `read_only`、`sandbox`、`controlled_delivery`，低等级不能运行高等级工具。
- Contract 要求 `EVAL_TARGET=staging`、专用 `EVAL_USER_ID` 和 `EVAL_AGENT_ID`。
- Canary 要求 `EVAL_TARGET=production`、`ALLOW_PROD_CANARY=1`、专用 user/Agent/channel/target。
- 独立 CLI 拒绝使用无法构造 WebSocket 上下文的企微 controlled delivery。
- live case 中的 seed、marker、日期和目标均从环境变量注入，不固化真实 ID 或业务数据。
- 报告仅保存 hash、结构预览、耗时和断言状态；不保存生产回答、完整工具输入输出或断言实际值。
- Canary 超时通过 `AbortController` 传给 Agent/provider，避免超时后继续后台调用。

## 影响模块与数据流

### 评测模型与执行器

- `src/evaluation/live-types.ts`：Contract、Canary、断言和报告类型。
- `src/evaluation/live-validator.ts`：YAML schema、approved review、重复次数和断言校验。
- `src/evaluation/live-loader.ts`：递归加载、状态筛选、重复 ID 检查与 case set hash。
- `src/evaluation/live-interpolation.ts`：`${ENV}` 和 `{{steps.<id>.<path>}}` 安全插值。
- `src/evaluation/live-safety.ts`：工具安全登记、目标环境、身份与投递门禁。
- `src/evaluation/live-assertions.ts` / `live-value.ts`：结构、类型、值、正则、数值关系、
  比率、日期顺序和 Canary 工具轨迹断言。
- `src/evaluation/contract-runner.ts`：顺序执行真实工具，前序输出只在内存中用于后序步骤。
- `src/evaluation/canary-runner.ts`：执行真实 Agent、重复采样、超时中止和脱敏轨迹汇总。
- `src/evaluation/live-runtime.ts`：初始化 DB、插件、MCP/provider，解析专用身份和有效工具权限。
- `src/evaluation/live-report.ts`：生成带 Git/package/case set 元数据的 JSON/Markdown 报告。

### CLI 与用例

- `scripts/evaluation/validate-contract-cases.ts`
- `scripts/evaluation/run-tool-contracts.ts`
- `scripts/evaluation/validate-canary-cases.ts`
- `scripts/evaluation/run-production-canary.ts`
- `scripts/evaluation/live-cli.ts`
- `evals/contracts/**`：14 个 Contract（6 approved、8 draft）。
- `evals/canary/**`：7 个 Canary（3 approved、4 draft）。

首批 approved Contract：

1. 知识库 marker 检索；
2. 搜索后按 `document_id` 读取全文；
3. 知识库空结果；
4. 拒绝读取其他 Agent 所属文档；
5. staging 合成客户查询；
6. 固定合成脚本的 sandbox 执行。

首批 approved Canary：

1. production 专用知识库 marker 检索；
2. 搜索后读取专用文档全文；
3. production 专用合成客户查询。

### Agent 与 frozen 回归兼容性修正

- `src/llm/agent.ts`
  - 新增只收窄、不扩权的 `toolAllowlist`；
  - loop warning 与对应 `tool_result` 放在同一个紧邻 user message，避免产生孤立
    `tool_use` 导致 provider 400。
- `src/evaluation/fixture-tool-definition.ts` 与 scenario runtime：
  - 从 fixture 的 exact/subset matcher 推导工具参数 schema，避免模型生成错误参数。
- frozen case：
  - 北向极速规模断言兼容“总名义规模”表述；
  - corporate action 空结果 case 明确要求同步失败后仍查询本地历史。

## 改动清单

- 新增 Contract / Canary 类型、校验、加载、安全门禁、执行、报告与 runtime。
- 新增 14 个 Contract case 和 7 个 Canary case。
- 新增四个 npm 命令：
  - `eval:contract:validate`
  - `eval:contract`
  - `eval:canary:validate`
  - `eval:canary`
- 新增 live runner、assertion、interpolation/safety、validator、Agent 消息顺序和 fixture
  schema 单元测试。
- 更新场景回归平台文档和 `evals/README.md`。
- 根包版本按项目规则从 `3.1.1` 升至 `3.1.2`，同步 package lock。

## 验证计划与结果

必须在当前隔离工作树执行：

```bash
npm run eval:contract:validate
npm run eval:canary:validate
./node_modules/.bin/tsc --noEmit
npm run eval:self-test
npm run eval:contract -- --dry-run
npm run eval:canary -- --dry-run
npm run eval:smoke
npm run eval:full
npm run docs:build
git diff --check
```

当前验证记录：

- Contract schema/safety validator：通过；14 个 case、6 个 approved，case set hash
  `e7e1da4a32fc2a8e0818f37b2486de7fa753b8d0739e7e552f9b8850061a5103`。
- Canary schema/safety validator：通过；7 个 case、3 个 approved，case set hash
  `8f8e36db672f640071ca93d6c749ff82ff5a860849fd26df6ab5f920b436dc69`。
- TypeScript：`./node_modules/.bin/tsc --noEmit` 通过。
- evaluation unit tests：14 个测试文件、34 个测试全部通过。
- Contract dry-run：6 个 approved case 均为 `inconclusive`；缺少专用 staging
  identity/seed 等 7 个环境变量，未执行真实 staging 工具链路，运行前后均未创建
  `data/samata.db`。
- Canary dry-run：3 个 approved case 均为 `inconclusive`；缺少 production
  identity/seed/target 等 9 个环境变量，未执行真实 production Agent 链路，运行前后均未创建
  `data/samata.db`。
- smoke：8/8 通过。
- full：最终 16/16 通过，每个 case 重复 3 次，共 48 次执行；报告
  `data/evaluation/runs/full-3ee25450-db72-4d88-b600-63a593e3c3ff.json`，case set hash
  `0ef4606c14eb86f0e5a40ecfbba7c6ddbed6ec12e2329d6a7f34f27d36fb0401`。
  最终全量前发现的失败均为正确答案的等价措辞误报，已受控补充“总名义规模 / 合计存续规模 /
  短端 / 空端”等业务同义词并通过定向 3 次及最终全量验证。
- docs build：VitePress 构建通过；`docs:plan-sync` 同时报告了仓库已有历史 PLAN 的
  frontmatter / canonicalDocs 告警，本次 PLAN 已进入索引且不新增该类告警。
- `git diff --check`：通过。
- Docker image：使用隔离工作树精确源码构建成功，本地标签
  `local/titans/otcclaw:v3.1.2-eval-contract-canary`；OCI version 与容器内
  `package.json` 均为 `3.1.2`，revision 为 `working-tree`。本轮未部署、未推送镜像、
  未重启服务。

## 构建与发布

- 本次修改影响 TypeScript 运行时代码、CLI、package version 和 Docker 构建内容，需要完成
  本地镜像构建验证。
- Docker build context 必须来自当前隔离工作树，不得使用主工作区的并行未提交内容。
- 预期本地验证标签：`local/titans/otcclaw:v3.1.2-eval-contract-canary`。
- 本轮只构建和核对镜像，不部署、不推送镜像、不重启服务。

## 提交与推送

- 当前 commit hash：待用户确认后提交。
- 验证完成后先向用户汇总改动范围、结果、镜像状态和待提交文件。
- 未经用户再次明确确认，不执行 `git add`、`git commit` 或 `git push`。
- 提交后同一分支必须同时推送到 `origin` 与 `github`。
