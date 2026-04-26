# Samata

多 Agent 智能助手平台，立意「技术平权」。支持飞书、Telegram、企微 Bot 及命令行多渠道接入，内置多 LLM Provider 切换、工具调用、知识库、技能系统与 MCP 集成。

> **衍语（YanYu / otcclaw）** 是系统内置的默认 agent，专注于客户展业知识助手。

## 架构概览

```
┌─────────────────────────────────────────────┐
│  npm run cli   (CLI 客户端，HTTP/SSE)         │
│  飞书 Bot  /  Telegram Bot  /  企微 Bot      │
└────────────────────┬────────────────────────┘
                     │ HTTP / SSE
┌────────────────────▼────────────────────────┐
│  npm run server  (主进程)                     │
│  ├── CLI API  http://127.0.0.1:3457          │
│  ├── 飞书 / Telegram / 企微 Bot 自动启动      │
│  └── SQLite DB                               │
└─────────────────────────────────────────────┘
```

- **客户端/服务端分离**：`npm run cli` 是轻量客户端，通过 HTTP/SSE 与 server 交互，不直连 DB
- **SSE 流式推送**：agentic chat 实时推送 `text / tool_start / tool_end / thinking / done / error` 事件，消除黑屏等待
- **Channel 隔离**：通过 `AsyncLocalStorage` 为每条执行路径注入 channel 标识（`cli | feishu | telegram | wework | system`）；`isSystemAdmin()` 仅在 `channel=cli && role=admin` 时成立，bot channel 永远不满足

## 多 Agent 系统

系统支持多个 agent 实例，每个 agent 独立管理工具权限、知识库、技能和成员。

| Agent ID  | 中文名   | 说明                            |
|-----------|--------|---------------------------------|
| otcclaw   | 衍语    | 客户展业知识助手，`tools_mode=all` |
| tutor     | 家庭教育 | 教育辅导，allowlist 工具模式      |
| alter-ego | 数字分身 | 个人分身                         |
| doctor    | 家庭医生 | 健康咨询                         |

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入至少 ANTHROPIC_API_KEY

# 启动服务端（主进程：DB + Bot + CLI API）
npm run server

# 新开终端，启动 CLI 客户端
npm run cli
```

其他启动方式：

```bash
npm run dev          # 开发模式（tsx watch，单进程 REPL）
npm run telegram     # 单独启动 Telegram Bot 进程
npm run wework       # 单独启动企微 Bot 进程
npm run start        # 通过 scripts/start.sh 启动（含 screen 守护）
npm run stop         # 停止 screen 守护进程
npm run check-readme # 检查 README 与实现是否一致
```

## 环境变量

### 必填

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |

### 可选

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_AUTH_TOKEN` | 自定义网关认证令牌 |
| `ANTHROPIC_BASE_URL` | 自定义网关地址 |
| `LLM_PROVIDER` | ��换 LLM provider（`anthropic` \| `minimax` \| `gemini` \| `openrouter`），默认 `anthropic` |
| `LLM_MODEL` | 覆盖默认模型名 |
| `SHOW_THINKING` | 显示 AI 思考过程和工具调用日志，默认 `true` |

### MiniMax

| 变量 | 说明 |
|------|------|
| `MINIMAX_API_KEY` | MiniMax API 密钥 |
| `MINIMAX_BASE_URL` | MiniMax API 地址 |
| `MINIMAX_MODEL` | MiniMax 模型名 |

### Gemini

| 变量 | 说明 |
|------|------|
| `GEMINI_API_KEY` | Gemini API 密钥 |
| `GEMINI_BASE_URL` | Gemini API 地址 |
| `GEMINI_MODEL` | Gemini 模型名 |

### OpenRouter

| 变量 | 说明 |
|------|------|
| `OPENROUTER_API_KEY` | OpenRouter API 密钥 |
| `OPENROUTER_BASE_URL` | OpenRouter API 地址 |
| `OPENROUTER_MODEL` | OpenRouter 模型名 |

### InfluxDB（交易数据，只读）

| 变量 | 说明 |
|------|------|
| `INFLUX_HOST` | InfluxDB 主机 |
| `INFLUX_PORT` | InfluxDB 端口 |
| `INFLUX_TOKEN` | InfluxDB 访问令牌 |
| `INFLUX_DATABASE` | 数据库名 |
| `INFLUX_TIMEOUT` | 查询超时（秒） |

### Feishu Bot

| 变量 | 说明 |
|------|------|
| `FEISHU_MODE` | 连接模式：`ws`（长连接）或 `webhook` |
| `FEISHU_PORT` | Webhook HTTP 监听端口，默认 `3001` |

### CLI API

| 变量 | 说明 |
|------|------|
| `CLI_API_PORT` | CLI API server 监听端口，默认 `3457`（避开 `ccr` 默认占用的 3456） |

## 命令列表

输入非命令文本时，自动转交 AI 助手以自然语言处理（agentic chat）。

### 所有用户

| 命令 | 说明 |
|------|------|
| `/client <list\|view\|add\|update\|delete\|advance\|rollback\|history>` | 客户管理（仅 otcclaw agent） |
| `/trade` | 交易查询（仅 otcclaw agent） |
| `/plot` | 交易曲线图（仅 otcclaw agent） |
| `/faq <关键词>` | 查询知识库 |
| `/faq-add <内容>` | 添加 FAQ |
| `/faq-update <id> <内容>` | 修改 FAQ |
| `/faq-del <id>` | 删除 FAQ |
| `/skill <list\|save\|run\|del>` | 自定义技能管理 |
| `/agent <list\|create\|switch\|info\|del\|member\|assign\|bot-app\|...>` | Agent 管理 |
| `/memory <list\|add\|search\|del>` | Memory 管理 |
| `/plugin <list\|run>` | 插件管理 |
| `/wework-qa <群组名>` | 企微 Q&A 提取（仅 alter-ego agent） |
| `/status` | 系统状态 |
| `/help` | 显示帮助 |
| `/reset` | 重置当前会话 |

### 管理员专用

| 命令 | 说明 |
|------|------|
| `/watch <start\|stop\|status>` | 企微消息监测 |
| `/bot <tg\|feishu> <start\|stop\|status>` | Bot 进程管理 |
| `/model <list\|anthropic\|minimax\|gemini\|openrouter>` | 切换 LLM Provider |
| `/user <list\|add\|update\|delete>` | 系统用户管理 |
| `/reload` | 热重载应用 |

## 项目结构

```
src/
├── index.ts           # 服务端入口
├── feishu-entry.ts    # 飞书 Bot 独立入口
├── telegram-entry.ts  # Telegram Bot 独立入口
├── wework-entry.ts    # 企微 Bot 入口
├── auth/              # 认证与 RBAC
├── cli/               # CLI 客户端（REPL + SSE 解析）
├── commands/          # 命令处理器（可复用业务函数）
├── config/
├── db/                # Schema、migrations、seed
├── feishu/            # 飞书 Bot
├── llm/               # AI agent + 多 LLM provider
├── models/
├── plugins/           # 插件系统
├── runtime/           # execution-context（AsyncLocalStorage）
├── server/            # CLI API server（HTTP/SSE）
├── services/          # wework-monitor、reminder-scheduler、mcp-manager
├── shared/            # cli-contract.ts（客户端/服务端共享类型）
├── telegram/          # Telegram Bot
├── tools/             # Tool handler 包装��
├── utils/             # 日志、表格渲染
└── wework/            # 企微 Bot
```

## 技术栈

- TypeScript + Node.js（ESM）
- SQLite（better-sqlite3，WAL 模式）
- 多 LLM Provider：Anthropic Claude、MiniMax、Gemini、OpenRouter
- Bot SDK：@larksuiteoapi/node-sdk（飞书）
- MCP：@modelcontextprotocol/sdk
- pino（结构化日志）
- puppeteer（markdown-to-image）
- undici（HTTP 客户端）
- Inquirer.js（交互式命令行）

## License

ISC


## local claude

1. npm run claude-proxy 
2. claude

