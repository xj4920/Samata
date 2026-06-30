---
docModules:
  - platform
docTopics:
  platform: Agent Loop 用户补充信息中断重启
canonicalDocs:
  - /platform/channels-and-sessions
  - /platform/agent-capability-model
status: implemented
---

# Agent Loop 用户补充信息中断重启

## 背景

当前 Samata 的自然语言对话入口会把同一个 session 的 `history` 直接传入 `runAgenticChat()`。当用户在 agent loop 仍在调用模型或工具时再次补充信息，现有实现缺少 per-session 的运行态协调：

- 旧 loop 可能继续执行并最终回复，无法及时吸收用户补充。
- 同一用户连续发送消息时，可能出现多个 loop 并发修改同一份 `history`。
- 现有 `src/utils/abort.ts` 是进程级全局取消，适合 CLI 手动 ESC 中断，不适合飞书、企微、Telegram 等多用户 bot 场景。

本方案目标是：同一 session 的新补充信息到达后，中断当前 loop，把补充内容加入该 session 的运行态上下文，再基于“原始问题 + 已收到的补充信息”重新开始一轮 agent loop。

## 当前 Session 管理

### CLI API / Stream

`src/server/cli-session.ts` 使用模块级 `Map<string, CliSession>` 管理 CLI session：

```ts
interface CliSession {
  id: string;
  user: User;
  agentName: string;
  history: Anthropic.MessageParam[];
  updatedAt: number;
}
```

`src/server/cli-executor.ts` 在 `executeCliInput()` 和 `executeCliStream()` 中直接调用：

```ts
runAgenticChat(session.history, input, session.user, ...)
```

也就是说，当前 `runAgenticChat()` 会直接修改 `session.history`。

### 飞书

`src/feishu/bot.ts` 每个 bot instance 维护：

```ts
sessions: Map<string, FeishuSession>
```

`FeishuSession` 保存 `history`、`agentName`、`lastImagePaths` 等状态。`handleAIChat()` 会将 `session.history` 直接传入 `runAgenticChat()`。当前代码在 `runAgenticChat()` 返回后还会额外追加一次 assistant message，这会形成潜在重复写入，实施时需要改成统一提交路径。

### 企业微信

`src/wework/session.ts` 每个 bot instance 维护独立 `sessions: Map<string, WeworkSession>`：

- 单聊 key：`userId`
- 群聊 key：`g:{chatid}:{userid}`

`WeworkSession.history` 同样会直接传入 `runAgenticChat()`。

### Telegram

`src/telegram/session.ts` 使用模块级 `Map<number, TelegramSession>`，key 为 `telegramUserId`。Telegram 轮询逻辑会异步处理每条消息，因此同一用户快速连续发送消息时，最容易触发同一 session 的多个 agent loop 并发运行。

### Agent Loop 对 History 的写入方式

`runAgenticChat()` 当前会直接操作传入的 `history`：

1. 追加本轮 user message。
2. 如果模型返回 tool use，追加 assistant tool_use。
3. 追加对应 user tool_result。
4. 多轮工具调用后追加最终 assistant 回复。

这意味着旧 loop 一旦已经开始，就可能在中断或失败前留下 partial `tool_use/tool_result` 结构。新方案必须避免旧 loop 直接污染 session 的正式历史。

## 设计决策

### 新增 Per-Session Turn Coordinator

新增 `src/session/agent-turn-coordinator.ts`，按 `channel/appId/sessionKey` 管理正在运行的 agent turn。建议核心结构：

```ts
type AgentTurnKey = string;

interface SupplementMessage {
  text: string;
  images?: ImageInput[];
  receivedAt: number;
  sourceMessageId?: string;
}

interface ActiveAgentTurn {
  key: AgentTurnKey;
  ownerToken: string;
  baseHistory: Anthropic.MessageParam[];
  originalInput: string;
  originalImages?: ImageInput[];
  supplements: SupplementMessage[];
  controller: AbortController;
  startedAt: number;
  restartCount: number;
}
```

字段含义：

- `baseHistory`：第一条消息触发 loop 时的 session 历史快照。每次重启都从这份稳定快照复制工作历史，避免继承旧 loop 的 partial 工具消息。
- `originalInput` / `originalImages`：本次问题最初的用户输入。
- `supplements`：用户在 loop 运行中再次发送的补充信息。多次补充按 `receivedAt` 顺序保存。
- `controller`：当前 loop 专属 `AbortController`，只取消同一个 session 的当前 loop。
- `ownerToken`：当前有效 loop 的唯一 token。旧 loop 即使晚于新 loop 返回，也不能写回 session history。
- `restartCount`：记录本次 turn 被补充信息重启的次数，用于日志、telemetry 和防循环保护。

### 补充信息如何加入上下文

新增统一入口：

```ts
runCoordinatedAgentTurn({
  channel,
  appId,
  sessionKey,
  history,
  input,
  images,
  user,
  agentConfig,
  runOptions,
  onSuperseded,
})
```

处理规则：

1. 若 `sessionKey` 没有运行中 turn：
   - 创建 `ActiveAgentTurn`。
   - 将当前 `history` 深拷贝为 `baseHistory`。
   - 将当前输入保存为 `originalInput`。
   - 从 `baseHistory` 拷贝出 `workingHistory` 调用 `runAgenticChat()`。
2. 若 `sessionKey` 已有运行中 turn：
   - 将新消息 append 到 `activeTurn.supplements`。
   - 调用旧 `activeTurn.controller.abort('superseded')`。
   - 新建 `AbortController` 和 `ownerToken`。
   - 从同一个 `baseHistory` 重新拷贝 `workingHistory`。
   - 重新发起 `runAgenticChat()`。

传给模型的新输入由 `originalInput` 和所有补充信息生成：

```text
{originalInput}

[用户补充信息]
以下是用户在你处理过程中追加的信息，请合并理解；若与前文冲突，以较新的补充为准。

1. 2026-06-30 14:03:12
{supplement 1}

2. 2026-06-30 14:03:25
{supplement 2}
```

图片补充同样进入 `supplements.images`。重启时将 `originalImages + supplements.images` 合并传给 `runAgenticChat()`，并在文本中保留补充消息与图片的对应关系。

### 多次补充信息支持

`supplements` 是数组，因此天然支持多次补充：

1. 第一条消息启动 loop。
2. 第二条消息追加为 `supplements[0]`，中断旧 loop 并重启。
3. 第三条消息追加为 `supplements[1]`，再次中断当前 loop 并重启。
4. 只有最后一次重启出的最新 `ownerToken` 可以提交最终 `history`。

为避免用户连续发送大量补充导致上下文膨胀，实施时增加保护：

- 默认最多保留最近 20 条补充。
- 默认补充文本总字符数上限为 8000。
- 超限时优先保留较新的补充；较早补充可截断并标注“较早补充已截断”。

### 如何中断 Agent Loop

`runAgenticChat()` 新增 `abortSignal` 选项：

```ts
interface RunAgenticChatOptions {
  abortSignal?: AbortSignal;
  ...
}
```

在以下位置检查该 signal：

- 图片预处理和首轮 LLM 调用前。
- 流式模型读取循环中。
- 非流式模型请求前后。
- transient retry 的等待期间。
- 每次工具调用前后。
- 每轮工具结果提交给模型前。
- wiki nudge 前。

新增 `SupersededTurnError` 或等价错误类型，用来区分“被用户补充信息替代”与真正失败。渠道层捕获该错误后不发送红色错误消息，只做温和提示或静默处理。

### Provider 层取消请求

为了避免只能在工具轮次之间取消，Provider 接口增加 request options：

```ts
interface LLMProvider {
  createMessage(params: CreateMessageParams, options?: { signal?: AbortSignal }): Promise<CreateMessageResult>;
  createMessageStream?(params: CreateMessageParams, options?: { signal?: AbortSignal }): AsyncGenerator<StreamEvent>;
}
```

适配方式：

- Anthropic：调用 `messages.create(params, { signal })`；stream 同样传入 SDK request options。
- OpenAI-compatible provider：`fetch(..., { signal })`。
- Gemini：`fetch(..., { signal })`。
- MiniMax：`fetchWithRetry()` 透传 `signal`，重试等待也响应 signal。

### 如何再次发起新一轮 Loop

重启流程固定为：

1. 当前 session 收到补充消息。
2. Coordinator 找到 `ActiveAgentTurn`。
3. 写入 `supplements`。
4. abort 当前 controller。
5. 创建新 controller 和 `ownerToken`。
6. 从 `baseHistory` 生成新的 `workingHistory`。
7. 用 `buildInputWithSupplements(originalInput, supplements)` 生成新 user input。
8. 调用 `runAgenticChat(workingHistory, mergedInput, user, { abortSignal })`。
9. 完成后检查 `ownerToken` 是否仍是最新。
10. 若是最新，将 `workingHistory` 覆盖回正式 `session.history`；否则丢弃。

这样可以保证旧 loop 无论何时返回，都不能写入正式 session。

## 渠道行为

- CLI stream：旧请求返回 `superseded` 事件或 log：“已收到补充信息，转由最新消息继续处理”；新请求输出最终结果。
- CLI 非流式 API：旧请求返回 ok 状态和 superseded 提示，避免客户端当作失败。
- 飞书：旧进度卡更新为“已收到补充信息，正在重新处理”；最终结果由最新 loop 更新或发送。
- 企业微信：旧 stream 结束为短提示，新 stream 输出最终答案。
- Telegram：旧 loop 静默取消，不额外发错误；最新 loop 发送最终答案。

## 实施改动

- 新增 `src/session/agent-turn-coordinator.ts`：
  - 使用 `channel/appId/sessionKey` 管理 per-session active turn。
  - 将第一轮输入保存为 `originalInput`，将后续用户消息追加到 `supplements`。
  - 每次补充都会中断旧 `AbortController`，创建新 `ownerToken` 并从 `baseHistory` 重启。
  - 只有最新 `ownerToken` 的 `workingHistory` 可以覆盖正式 `session.history`。
- 扩展 `runAgenticChat()`：
  - 新增 `RunAgenticChatOptions.abortSignal`。
  - 新增 `SupersededTurnError`，将用户补充触发的替代中断与真实错误区分。
  - 在模型调用、工具循环、retry delay、wiki nudge、最终提交前检查 abort。
- 扩展 LLM provider：
  - `createMessage()` / `createMessageStream()` 支持 `{ signal }`。
  - Anthropic 走 SDK request options；Custom/DeepSeek/OpenRouter/Gemini/MiniMax 走 fetch signal。
  - MiniMax retry 等待也响应 abort。
- 接入渠道入口：
  - CLI API/stream、飞书、企微、Telegram 的自然语言 agent chat 改为 `runCoordinatedAgentTurn()`。
  - `/reset` 会先取消对应 session 的 active turn，再清空 history。
  - 飞书移除 `runAgenticChat()` 后额外追加 assistant 的重复 history 写入路径。
  - 定时任务 `agent_chat` 保持原有直连 `runAgenticChat()`，不参与用户补充中断。

## Harness Issue / Branch

已创建 Code issue，并将本方案文档作为 issue 描述提交：

- Project ID：`33779`
- Issue：`#31`
- Ident：`I7G8`
- URL：`https://devops.gf.com.cn/gf/_code/gf/gzxujun/samata/-/issues/31`

最初尝试在 issue 创建时同时携带 `branch_name`、`tag`、`auto_close_enabled`：

```bash
harness code issue create "Agent loop 支持用户补充信息中断并重启" --repo-path gf/gzxujun/samata --lookup-project-id --branch-name codex/agent-loop-supplement-restart --tag samata-agent-loop --auto-close-enabled 1 --description-file docs/plan/2026-06-30_agent-loop-user-supplement-restart.md
```

该请求在当前 Code API 下返回 `HTTP 400: {"message":"请求参数错误","code":0}`。因此最终采用最小字段创建 issue：标题 + `docs/plan/2026-06-30_agent-loop-user-supplement-restart.md` 转换后的描述，确保方案先进入 Code issue。

专用远端分支/worktree 尚未创建。此前直接执行：

```bash
harness code branch create codex/agent-loop-supplement-restart --ref main --repo-path gf/gzxujun/samata --lookup-project-id --local-repo /home/xj/work/source/samata --worktree /home/xj/work/source/samata-agent-loop-supplement-restart --repo-key samata --purpose "Agent loop 用户补充信息中断重启" --no-bootstrap
```

曾因代理链路出现 `SSL: UNEXPECTED_EOF_WHILE_READING`。后续已将 `gf.com.cn`、`.gf.com.cn`、`*.gf.com.cn`、`devops.gf.com.cn` 加入用户级 `NO_PROXY/no_proxy`，但系统 resolver 仍需将 `10.55.66.66`、`10.80.66.66` 作为默认 DNS 才能让普通 harness 命令稳定解析 `devops.gf.com.cn`。本次 issue 提交使用一次性进程内 DNS 映射访问同一个 Code API，未修改系统 DNS。

## 验证计划与结果

新增或更新单测：

- `tests/unit/session/agent-turn-coordinator.test.ts`
  - 同一 session 第二条消息会取消第一条。
  - 多条补充按时间顺序进入 prompt。
  - 旧 loop 不覆盖正式 history。

验证命令：

```bash
npx tsc --noEmit
npm run test:unit -- tests/unit/session/agent-turn-coordinator.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts
npm run docs:plan-sync -- --check
npm run docker:samata:build
git diff --check
```

验证结果：

- `npm run test:unit -- tests/unit/session/agent-turn-coordinator.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts` 通过，2 个测试文件 4 个用例通过。
- `git diff --check` 通过。
- `npx tsc --noEmit --pretty false` 未发现本次改动相关类型错误，但因既有 `src/services/mcp-manager.ts` `ParsedLogyiDate | null` 赋值给 `ParsedLogyiDate | undefined` 报错退出 2。
- `npm run docs:plan-sync -- --check` 确认 `docs/.vitepress/plan-index.generated.ts is up to date`，但因历史 plan frontmatter / canonicalDocs 既有问题退出 1。

## 构建与重启判断

本次实现修改运行时代码，需要重新构建 Samata Docker image。

- 已执行 `npm run docker:samata:build`。
- 构建成功，生成 `samata:3.0.13-04e962b1936f-dirty-20260630095223`。
- 已刷新 `samata:3.0.13` 与 `samata:latest`。
- 尚未重启正在运行的 Samata 容器。

## Commit Hash

- 实现提交：待提交后补充。
