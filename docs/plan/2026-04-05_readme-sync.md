---
docModules: []
docTopics: {}
canonicalDocs: []
status: archived
---

# Plan: README 同步更新

## Context

README.md 停留在项目早期版本（单进程 REPL + CRM 阶段），与当前实现严重不符。
当前代码已演进为：
- 多进程客户端/服务端架构（CLI over HTTP/SSE）
- 多 bot channel（飞书、Telegram、企微）
- 多 agent 系统（4 个默认 agent）
- 多 LLM provider（Anthropic / MiniMax / Gemini / OpenRouter）
- MCP 集成

本次任务：将 README.md **完全重写**，使其与当前实现保持一致。

---

## 需要修改的文件

- **`README.md`** — 唯一需要改动的文件（近全量重写）

---

## 具体更新内容

### 1. 项目名称与定位

- 标题改为 **Samata**（立意「技术平权」）
- 说明「衍语（YanYu/otcclaw）」是系统内置的一个 agent，专注于客户展业知识助手
- 保留中英双语风格

### 2. 快速开始

替换启动命令：
```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env

# 启动服务端（主进程：DB + Bot + CLI API）
npm run server

# 新开终端，启动 CLI 客户端
npm run cli
```

### 3. 架构说明（新增章节）

#### 客户端 / 服务端分离
- `npm run server` — 主进程，启动 DB、飞书/Telegram/企微 bot、CLI API（`http://127.0.0.1:3457`，避开 ccr 默认 3456）
- `npm run cli` — 轻量 CLI 客户端，通过 HTTP/SSE 连接 server，不直接访问 DB

#### SSE 流式推送
- `POST /api/cli/stream` — agentic chat 通过 SSE 实时推送 chunk
- 事件类型：`text` / `tool_start` / `tool_end` / `thinking` / `log` / `done` / `error`
- 消除 agentic 推理时的黑屏等待

#### Channel 隔离
- 所有执行路径通过 `AsyncLocalStorage` 携带 channel 标识
- channel 类型：`cli` | `feishu` | `telegram` | `wework` | `system`
- `isSystemAdmin()` = `channel === 'cli' && role === 'admin'`，bot 永远不满足

#### 多 Agent 系统
四个内置 agent：

| Agent ID    | 中文名   | 说明 |
|-------------|--------|------|
| otcclaw     | 衍语    | 客户展业知识助手，tools_mode=all |
| tutor       | 家庭教育 | 教育辅导，allowlist 模式 |
| alter-ego   | 数字分身 | 个人分身 |
| doctor      | 家庭医生 | 健康咨询 |

### 4. 环境变量（完整列表）

基于 `.env.example`，按模块分组说明：
- **必填**：`ANTHROPIC_API_KEY`
- **可选**：`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`（自定义网关）
- **多 LLM**：MiniMax / Gemini / OpenRouter 各自的 key/url/model，`LLM_PROVIDER` 切换
- **调试**：`SHOW_THINKING`
- **InfluxDB**：`INFLUX_HOST`、`INFLUX_PORT`、`INFLUX_TOKEN`、`INFLUX_DATABASE`、`INFLUX_TIMEOUT`
- **Feishu**：`FEISHU_MODE`（ws/webhook）、`FEISHU_PORT`
- **CLI API**：`CLI_API_PORT`（默认 3457，避开 ccr 默认 3456）

### 5. 命令列表（基于 router.ts）

分两组：

**所有用户可用**（14 个）：
`/client`（子命令：list/view/add/update/delete/advance/rollback/history）、`/trade`、`/plot`、`/faq`、`/faq-add`、`/faq-update`、`/faq-del`、`/skill`、`/agent`、`/memory`、`/plugin`、`/wework-qa`、`/status`、`/help`

**管理员专用**（4 个）：
`/watch`、`/bot`、`/model`、`/user`

**内置特殊**：`/reload`、`/reset`、`/exit`

### 6. 项目结构（更新 src/ 树）

```
src/
├── index.ts           # 服务端入口
├── feishu-entry.ts    # 飞书 bot 独立入口
├── telegram-entry.ts  # Telegram bot 独立入口
├── wework-entry.ts    # 企微 bot 入口
├── auth/              # 认证与 RBAC
├── cli/               # CLI 客户端（REPL + SSE 解析）
├── commands/          # 命令处理器（可复用业务函数）
├── config/
├── db/                # Schema、migrations、seed
├── feishu/            # 飞书 bot
├── llm/               # AI agent + 多 LLM provider
├── models/
├── plugins/
├── runtime/           # execution-context（AsyncLocalStorage）
├── server/            # CLI API server（HTTP/SSE）
├── services/          # wework-monitor、reminder-scheduler、mcp-manager
├── shared/            # cli-contract.ts（客户端/服务端共享类型）
├── telegram/          # Telegram bot
├── tools/             # Tool handler 包装层
├── utils/
└── wework/            # 企微 bot
```

### 7. 技术栈（补充）

在原有基础上补充：
- 多 LLM provider：MiniMax、Gemini、OpenRouter
- pino（结构化日志）
- puppeteer（markdown-to-image）
- @modelcontextprotocol/sdk（MCP 工具服务器集成）
- @larksuiteoapi/node-sdk（飞书 SDK）
- undici（HTTP 客户端）

---

## 不在此次 README 更新范围内

以下是审计发现的代码问题，需单独处理（非 README 任务）：
- `src/commands/wework.ts:5` — 硬编码绝对路径 `/Users/simon/...`（违反 CLAUDE.md 规范）
- `src/scripts/import-customers.ts` / `inspect-xlsx.ts` — 同上

---

## 验证方式

1. 对照 `package.json` scripts 确认启动命令描述正确
2. 对照 `src/commands/router.ts` 确认命令列表和权限准确
3. 对照 `.env.example` 确认环境变量无遗漏
4. 通读 README，确认新开发者能根据 README 完成本地启动
