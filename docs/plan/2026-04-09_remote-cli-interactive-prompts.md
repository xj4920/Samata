---
docModules:
  - platform
docTopics:
  platform: 渠道与会话
canonicalDocs:
  - /platform/channels-and-sessions
status: implemented
---

# Remote CLI Interactive Prompts

## 背景

CLI 客户端 (`npm run cli`) 通过 HTTP/SSE 与 server 通信。当用户输入 `/faq-add` 等需要交互式输入的命令时，`@inquirer/prompts` 的 `input()` 绑定到 server 进程的 stdin，导致提示出现在 server 终端而非客户端终端。

## 方案

扩展 SSE 协议，新增 `prompt` 事件类型，让 server 能向客户端"提问"并等待回答：

```
Client  ──POST /api/cli/stream──>  Server  ──> Command Handler
                                     │
                                     │  需要用户输入
                                     │
Client  <──SSE prompt {id, msg}────  Server
                                     │
Client  ──POST /api/cli/prompt-reply──>  Server  ──> resolve Promise
                                     │
                                     │  继续执行
```

## 实现

### 协议层
- `src/shared/cli-contract.ts`: `CliStreamEvent` 新增 `prompt` 类型

### 执行上下文
- `src/runtime/execution-context.ts`: `ExecutionContext` 新增 `promptFn` 回调；导出 `remoteInput()`、`remoteSelect()`、`remoteConfirm()` 三个适配器函数，自动根据上下文选择本地 inquirer 或远程 prompt

### Server 端
- `src/server/cli-session.ts`: 新增 `waitForPromptReply()` / `resolvePromptReply()` Promise 队列
- `src/server/cli-executor.ts`: `executeCliStream()` 中注入 `promptFn`，通过 SSE 发送 prompt 事件并等待回复
- `src/server/cli-api.ts`: 新增 `POST /api/cli/prompt-reply` 端点

### Client 端
- `src/cli/api-client.ts`: 新增 `sendPromptReply()` 函数
- `src/cli/index.ts`: SSE 事件循环中处理 `prompt` 事件，用 `readline.question()` 读取用户输入后 POST 回 server

### 命令适配
- `src/commands/knowledge.ts`: `add()` / `update()` 改用 `remoteInput()`
- `src/commands/agent.ts`: `createAgent()` / `assignAgent()` 改用 `remoteInput()` / `remoteSelect()` / `remoteConfirm()`
