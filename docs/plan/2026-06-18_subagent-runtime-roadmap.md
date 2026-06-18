---
docModules:
  - platform
docTopics:
  platform: Subagent 运行时路线图
canonicalDocs:
  - /platform/agent-capability-model
status: planned
---

# Samata 通用 Subagent Runtime Roadmap

## 背景

Ticlaw 在处理 Titans / Libra 生产问题定位时，单一 agent 需要同时消化 Wiki、导入文档、代码检索、LogYi 日志、历史结论和当前定位假设。现有 `runAgenticChat()` 是单 agent 串行 loop，所有工具结果都回到同一段 history；即使已有工具结果截断、知识检索限流和上下文溢出兜底，复杂定位任务仍容易出现上下文膨胀、证据混杂和复盘困难。

本路线图的目标不是为 Ticlaw 写一组固定的“问题调查 agent”，而是在 Samata 中引入通用 subagent runtime。Ticlaw 的 Wiki / Code / Log worker 只是第一批落地场景；同一套运行时后续应能服务开发实现、文档生产、数据分析、运维处置和知识治理。

参考材料：

- `shareAI-lab/learn-claude-code` 的 `s06_subagent`：一次性 subagent 使用独立 `messages[]`，只把摘要返回父 agent。
- `shareAI-lab/learn-claude-code` 的 `s15_agent_teams` / `s16_team_protocols`：长期 agent 通过 inbox、request id 和协议消息协作。
- 公众号文章《面试官皱眉：“你知道 Claude Code 多Agent实现机制吗？”》：强调父子 agent 的 mailbox / notification 通信、Fork Subagent 和 Coordinator 模式。
- Samata 当前实现：`src/llm/agent.ts`、`src/llm/agents/config.ts`、`src/tools/index.ts`、`src/services/task-scheduler.ts`。

## 当前机制判断

Samata 当前已有“多 Agent 实例”，但没有真正的父子 subagent 编排机制。

已具备能力：

- Agent 配置：`id`、`name`、`displayName`、`model`、`provider`、`toolsMode`、`toolsList`、`maxHistory`。
- Agent 渠道绑定：飞书、企微、Telegram、CLI 通过 assignment 解析到某个 Agent。
- 工具隔离：`getAgentTools()` 按 agent 配置和用户角色过滤工具。
- Prompt 注入：memory、skills、wiki guidance、dream、workspace 注入当前 Agent system prompt。
- 定时 `agent_chat`：可以由 scheduler 独立运行一次 agent 对话，但它是 cron 任务，不是用户请求内的父子委派。

缺失能力：

- 没有 `delegate_task` / `run_subagent` 这类委派工具。
- 没有父子 session tree、子 agent 独立 history、独立 token budget。
- 没有 Wiki / Code / Log worker 并行调度。
- 没有 subagent 输出 schema、`TaskResult` / evidence contract。
- 没有主 Agent 汇总多个子 Agent 结果的 merge / reduce 流程。
- 没有父子 Agent 之间的 mailbox、notification queue、`requestId` 协议。

## 核心决策

- 将 subagent 设计为“可委派工作单元 runtime”，不要设计成 Ticlaw 专用调查工具。
- 第一版支持 named subagent；后续再演进到 fork subagent 和 coordinator。
- 子 agent 默认使用独立 `messages[]`，中间工具结果不进入父 agent history。
- 父子 agent 通信使用消息，不只依赖同步函数返回。
- 短任务可 foreground 同步返回；长任务应转 background，通过 notification 注入父 agent。
- 子 agent 结果必须结构化，父 agent 只接收 `TaskResult`、evidence、artifact ref，不接收大段原始材料。
- 工具隔离和上下文隔离都按字段语义决策：该共享的共享，该克隆的克隆，该屏蔽的屏蔽，该新建的新建。
- Subagent runtime 不写入 Samata 运行时 memory 数据库；长期规则沉淀继续走配置文件、文档、wiki 或明确的数据表。

## 通信机制

父到子：

```text
main agent
  -> send_subagent_message(taskId, message)
  -> subagent.pendingMessages
  -> subagent loop 边界 drain pendingMessages
  -> 作为 user message 注入 subagent 自己的 history
  -> subagent 继续运行
```

子到父：

```text
subagent 完成或产生阶段性结果
  -> task_notification
  -> parent pending notifications
  -> main agent loop 边界 drain notifications
  -> 作为结构化 user message 注入主 history
  -> main agent 合成、追问或继续派活
```

这套通信机制带来的能力：

- 主 agent 不需要长期同步阻塞等待子任务。
- 多个 subagent 可以并行工作，谁先完成谁先通知。
- 主 agent 可以给运行中的 subagent 追加指令。
- 已完成 subagent 可以通过 transcript 恢复后被唤醒继续处理新消息。
- 父子通信天然兼容现有 agentic loop，不需要另写一套复杂回调状态机。

## 数据模型草案

### WorkerSpec

`WorkerSpec` 定义 worker 能做什么，而不是绑定业务场景。

```ts
interface WorkerSpec {
  name: string;
  description: string;
  mode: 'named' | 'fork' | 'coordinator-worker';
  allowedTools: string[];
  deniedTools: string[];
  systemPrompt: string;
  maxRounds: number;
  timeoutMs: number;
  outputSchema: unknown;
  triggerHints: string[];
}
```

### TaskEnvelope

`TaskEnvelope` 是主 agent 委派任务时传给 subagent runtime 的任务包。

```ts
interface TaskEnvelope {
  goal: string;
  inputRefs: Array<{ type: string; ref: string }>;
  constraints: string[];
  expectedOutputSchema: string;
  allowedCapabilities: string[];
  budget: {
    maxRounds: number;
    timeoutMs: number;
    maxResultChars: number;
  };
  isolationPolicy: string;
  communicationMode: 'foreground' | 'background' | 'auto';
  mergePolicy: string;
}
```

### MessageEnvelope

`MessageEnvelope` 支撑 mailbox、notification 和协议请求。

```ts
interface MessageEnvelope {
  type: 'message' | 'task_notification' | 'protocol_request' | 'protocol_response';
  from: string;
  to: string;
  taskId: string;
  requestId?: string;
  content: string;
  payload?: unknown;
  createdAt: string;
}
```

### SubagentTaskRecord

`SubagentTaskRecord` 记录 subagent 生命周期和通信状态。

```ts
interface SubagentTaskRecord {
  id: string;
  parentRunId: string;
  parentAgentId: string;
  workerName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
  pendingMessages: MessageEnvelope[];
  notifications: MessageEnvelope[];
  transcriptRef?: string;
  resultRef?: string;
  createdAt: string;
  updatedAt: string;
}
```

### TaskResult

`TaskResult` 比 evidence 更通用，适用于调查、开发、文档、数据、运维等任务。

```ts
interface TaskResult {
  status: 'completed' | 'partial' | 'failed';
  summary: string;
  findings: Array<{
    claim: string;
    evidence?: Provenance[];
    confidence?: 'high' | 'medium' | 'low';
    uncertainty?: string;
  }>;
  artifacts: Array<{ type: string; ref: string; description?: string }>;
  risks: string[];
  nextActions: string[];
}
```

### Provenance

`Provenance` 统一追溯来源，不限于问题调查。

```ts
interface Provenance {
  sourceType:
    | 'wiki'
    | 'document'
    | 'code'
    | 'log'
    | 'file'
    | 'url'
    | 'db_query'
    | 'tool_call'
    | 'artifact'
    | 'human_input';
  source: string;
  snippet?: string;
  toolCallId?: string;
}
```

## Roadmap

### Phase 0：现状基线与切入点

目标：确认当前单 agent 痛点和插入位置。

实现路径：

- 梳理 `runAgenticChat()` 主循环、工具执行、tool result 截断、context overflow fallback。
- 统计 Ticlaw 常见定位任务中的工具调用次数、返回字符数、上下文增长、耗时。
- 明确当前 agent 机制：多 Agent 配置存在，但没有父子 agent runtime。

受影响模块：

- `src/llm/agent.ts`
- `src/llm/agents/config.ts`
- `src/tools/index.ts`
- `src/telemetry/*`

验证：

- 选 2-3 个真实 Ticlaw 问题，记录当前上下文规模和工具结果注入量，作为后续对照。

### Phase 1：定义通用协议与数据模型

目标：先把 subagent 的契约定稳，避免后面做成业务硬编码。

实现路径：

- 新增 `WorkerSpec`、`TaskEnvelope`、`TaskResult`、`Provenance`、`MessageEnvelope` 类型。
- 增加结果 schema 校验。
- 增加超长结果压缩或拒绝策略。

受影响模块：

- 新增 `src/llm/subagents/types.ts`
- 新增 `src/llm/subagents/result-schema.ts`
- 复用 `src/utils/json-repair.ts`

验证：

- 单测覆盖合法和非法 `TaskResult`。
- 缺少 source、超长 snippet、非法 status 都能被识别。

### Phase 2：Subagent Runtime MVP

目标：实现最小可用的一次性 subagent，类似 `learn-claude-code` 的 `s06_subagent`。

实现路径：

- 新增 `runSubagent()`：独立 `messages[]`、独立 system prompt、工具白名单、最大轮次、最大输出长度。
- 新增 `delegate_task` 工具：主 agent 可选择 worker 或让系统 auto route。
- 第一版 foreground，同步等待短任务完成。

受影响模块：

- 新增 `src/llm/subagents/registry.ts`
- 新增 `src/llm/subagents/run.ts`
- 新增 `src/tools/subagent-tools.ts`
- 修改 `src/tools/index.ts`
- 小范围修改 `src/llm/agent.ts`

验证：

- 子 agent 不能调用未授权工具。
- 子 agent 不能递归调用 `delegate_task`。
- 子 agent 的中间 messages 不进入主 history。
- 主 agent 只收到结构化 `TaskResult`。

### Phase 3：消息通信机制

目标：吸收公众号和 `learn-claude-code` 的 mailbox / protocol 思路，不停留在简单函数返回。

实现路径：

- 每个 subagent task 维护 `pendingMessages`。
- subagent 每轮 LLM 前 drain 自己的 `pendingMessages`，注入自己的 history。
- 主 agent 每轮 LLM 前 drain task notifications，注入主 history。
- 新增工具：`send_subagent_message`、`list_subagent_tasks`、`stop_subagent_task`。
- 引入 `requestId`，用于 `protocol_request` / `protocol_response` 状态关联。

受影响模块：

- 新增 `src/llm/subagents/task-store.ts`
- 新增 `src/llm/subagents/message-bus.ts`
- 修改 `src/llm/agent.ts`，在 LLM 调用边界注入 notification drain。
- 修改 `src/tools/subagent-tools.ts`。

验证：

- 主 agent 能给运行中的 subagent 追加指令。
- subagent 完成后通知主 agent。
- notification 只含摘要和 `resultRef`，不含大段原文。
- `requestId` 能正确关联请求与响应。

### Phase 4：后台化与可恢复 transcript

目标：长任务不阻塞主 agent。

实现路径：

- `delegate_task` 增加 `mode: foreground | background | auto`。
- 超过阈值，例如 30-60 秒，自动转后台。
- subagent transcript 写入磁盘或 DB ref。
- 后续 `send_subagent_message` 可唤醒已完成或暂停的 subagent，恢复 transcript 继续跑。

受影响模块：

- 新增 subagent runtime task manager。
- 可借鉴 `src/services/task-scheduler.ts` 的后台执行与通知思路，但不要混用 cron task。
- telemetry 记录 task span。

验证：

- 长任务启动后主 agent 可以继续响应。
- 子任务完成后 notification 能进入主 agent 下一轮。
- transcript 恢复后可继续处理新消息。

### Phase 5：Ticlaw 首批 Worker

目标：用真实场景验证通用 runtime，而不是把 runtime 写死在 Ticlaw。

首批 worker：

- `ticlaw-wiki-researcher`
  - 工具：`search_knowledge`、`read_wiki_page`、`read_knowledge_document`。
  - 输出：需求背景、历史结论、相关 wiki / document evidence。
- `ticlaw-code-researcher`
  - 工具：`titans_code_sync`、`titans_code_grep`、`titans_code_read`、`titans_code_list`。
  - 输出：疑似模块、文件、符号、调用链 evidence。
- `ticlaw-log-researcher`
  - 第二批接入，工具为 LogYi MCP。
  - 需要单独处理查询窗口、异步查询、输出压缩。

验证：

- 回放 Phase 0 的真实问题。
- 对比主 history 字符数、工具结果注入量、最终可追溯性。
- 目标：主上下文注入量下降 50% 以上。

### Phase 6：并行委派

目标：从能委派升级到能并行。

实现路径：

- 新增 `delegate_tasks`。
- 支持 `strategy: parallel | chain | race | review`。
- 同一条 assistant message 可触发多个子任务。
- 每个子任务独立 timeout、budget、工具白名单。
- 主 agent 收到多个通知后做合成。

验证：

- Wiki / Code 两个 worker 并行跑。
- 一个失败不影响另一个结果回收。
- 主 agent 能标记“代码证据不足，但 wiki 证据支持”等部分结论。

### Phase 7：Fork Subagent

目标：处理需要完整父上下文但不能污染主线的通用场景。

适用场景：

- 生成多版方案。
- 写 PR 描述。
- 做 post-turn summary。
- 让另一个分身 review 主 agent 的结论。

设计要点：

- 复用父 agent 已渲染 system prompt。
- 复用稳定工具定义顺序。
- 复用父 messages 前缀。
- 只在任务尾部追加 fork 指令。
- 尽量保持 prompt cache 命中。

验证：

- 同一父会话 fork 多个分支，互不污染。
- 成本和首 token 延迟有观测指标。
- fork child 不能递归 fork 失控。

### Phase 8：Coordinator 模式

目标：支持大任务多 worker 协作。

实现路径：

- 新增 coordinator prompt 模式：主 agent 不亲自查资料、改代码或跑测试，只负责拆任务、派 worker、收结果、合成。
- worker 有 inbox、状态、transcript。
- 引入协议：plan approval、result acceptance、handoff、shutdown。
- 用 `requestId` 做请求-响应关联。

适用场景：

- 大型功能开发。
- 多模块迁移。
- 跨文档、代码、数据源报告。
- 长周期知识治理。

验证：

- 多 worker 并行完成一个大任务。
- 每个协议请求都有状态表。
- coordinator 能根据结果决定继续派活、追问、终止或合成。

## 第一阶段建议范围

第一期不要做完整 coordinator，也不要做 worktree isolation。建议只做：

- `WorkerSpec` / `TaskEnvelope` / `TaskResult` / `MessageEnvelope`。
- `runSubagent()` foreground MVP。
- `delegate_task`。
- subagent 工具白名单和禁止递归。
- `ticlaw-wiki-researcher`。
- `ticlaw-code-researcher`。
- 主上下文注入量对比验证。

第二期做：

- background task。
- notification queue。
- `send_subagent_message`。
- transcript 恢复。
- `delegate_tasks` 并行。

第三期做：

- fork subagent。
- coordinator。
- protocol request / response。
- 自治 worker、task board、worktree isolation。

## 验收标准

- 对典型 Ticlaw 问题定位任务，主 agent 上下文中注入的原始 Wiki、代码、日志材料显著减少，优先只保留结构化 `TaskResult` / evidence。
- Wiki 与 Code 调研可以并行触发，并能被主 agent 合并为统一定位报告。
- 每条关键结论都能追溯到来源，如 Wiki 页面、文档 ID、代码文件、符号、日志查询条件或工具调用 ID。
- subagent 不能越权调用未授权工具，不能递归派生 subagent。
- 长任务可以后台化，完成后通过 notification 注入主 agent，而不是长期阻塞主 agent。
- 有可观测日志或 telemetry，能复盘 subagent 输入、输出、耗时、命中数量、裁剪策略和失败原因。

## 待澄清问题

- 第一版 `SubagentTaskRecord` 是落 DB，还是先落内存和 transcript 文件。
- 主 agent notification 注入点放在每轮 LLM 前，还是每次 tool loop 结束后。
- `TaskResult` schema 是所有 worker 共用一个基础 schema，还是基础 schema 加 worker-specific schema。
- Fork Subagent 是否依赖当前 provider 的 prompt cache 能力，非 Anthropic provider 如何降级。
- foreground 自动转 background 的阈值取 30 秒、60 秒还是按 worker 配置。

## 改动清单

- 新增 `docs/plan/2026-06-18_subagent-runtime-roadmap.md`
  - 记录 Samata 引入通用 subagent runtime 的背景、决策、通信机制、数据模型、分阶段 roadmap、验收标准和待澄清问题。
- 更新 `docs/.vitepress/plan-index.generated.ts`
  - 通过 `npm run docs:plan-sync` 将本路线图纳入计划索引。

## 验证命令

- 已执行：`git pull --ff-only`，结果为“已经是最新的”。
- 已执行：`git diff --check -- docs/plan/2026-06-18_subagent-runtime-roadmap.md`，通过。
- 已执行：`npm run docs:plan-sync`，成功更新 `docs/.vitepress/plan-index.generated.ts`；输出仍包含若干历史 plan 缺少或未配置 `docModules` 的既有提示，本次新增文件未被点名。
- 已执行：`npm run docs:plan-sync -- --check`，确认 `docs/.vitepress/plan-index.generated.ts is up to date`；命令因上述历史 plan frontmatter error 退出码为 1，本次新增文件未被点名。

## Commit Hash

- 初始提交：`68bc72a473d834ba7d31175d8763542dae0c80a9`。

## 构建与重启判断

该改动仅新增计划文档，不影响 TypeScript 运行时代码、Docker image、插件构建产物、依赖或数据库迁移；不需要重新构建镜像或重启服务。
