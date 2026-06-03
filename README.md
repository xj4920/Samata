# Samata

---

多 Agent 智能助手平台。支持飞书、Telegram、企微 Bot 及命令行多渠道接入，内置多 LLM Provider 切换、工具调用、知识库、技能系统与 MCP 集成。

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
│  ├── Plugin 系统（外部目录加载）              │
│  └── SQLite DB                               │
└─────────────────────────────────────────────┘
```

- **客户端/服务端分离**：`npm run cli` 是轻量客户端，通过 HTTP/SSE 与 server 交互，不直连 DB
- **SSE 流式推送**：agentic chat 实时推送 `text / tool_start / tool_end / thinking / done / error` 事件，消除黑屏等待
- **Channel 隔离**：通过 `AsyncLocalStorage` 为每条执行路径注入 channel 标识（`cli | feishu | telegram | wework | system`）；`isSystemAdmin()` 仅在 `channel=cli && role=admin` 时成立，bot channel 永远不满足
- **Plugin 外置**：plugin 源码独立于主仓库，通过 `SAMATA_PLUGINS_DIR` 环境变量指向外部目录（支持逗号分隔多路径）

## 多 Agent 系统

系统支持多个 agent 实例，每个 agent 独立管理工具权限、知识库、技能和成员。

| Agent ID  | 中文名   | 说明                            |
|-----------|--------|---------------------------------|
| alter-ego | 数字分身 | 个人分身                         |

## 快速开始

### 环境要求

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | v20+ | 推荐 v22 LTS，使用 nvm 管理 |
| npm | v10+ | 随 Node.js 自带 |
| Git | v2.30+ | 拉取代码 |
| better-sqlite3 编译工具链 | — | `python3`、`make`、`gcc/g++`（macOS 装 Xcode CLI Tools） |

### 安装与启动

```bash
# 克隆主仓库（使用当前页面提供的克隆地址）
git clone <repo-url>
cd samata

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，至少配置一个 LLM Provider

# 启动服务端（主进程：DB + Bot + CLI API）
npm run server

# 新开终端，启动 CLI 客户端
npm run cli
```

### 加载 Plugins

Plugin 源码独立管理，与主仓库分离。两种加载方式：

**方式一：源码加载（开发调试，推荐）**

```bash
# 在 samata 同级目录克隆 plugin 仓库
cd ..
git clone <plugins-repo-url>
cd samata-plugins && npm install
```

在 `.env` 中配置（支持逗号分隔多目录）：

```env
SAMATA_PLUGINS_DIR=../samata-plugins,../samata-plugin-work
```

**方式二：npm install（生产部署）**

```bash
npm install @samata-platform/plugin-csv-export
npm install @samata-platform/plugin-excel-parser
# ... 按需安装
```

Samata 启动时自动扫描 `package.json` 中 `@samata-platform/plugin-*` 依赖并加载。

> 两种方式可共存：目录插件优先加载，同名 npm 插件自动跳过。

### 创建自定义 Agent（以 Moss 为例）

1. 创建 prompt 文件 `config/agents/moss.md`
2. 在 CLI 中执行 `/agent create moss Moss "个人智能助手"`
3. 如需绑定飞书：`/agent assign moss feishu cli_xxxxxxxxxx`

详细步骤参见 [部署与模型](docs/platform/deployment.md)，原始演进记录保留在 [Moss 部署指南](docs/plan/2026-05-25_moss-deployment-guide.md)。

### 其他启动方式

```bash
npm run dev          # 开发模式（tsx watch，单进程 REPL）
npm run telegram     # 单独启动 Telegram Bot 进程
npm run wework       # 单独启动企微 Bot 进程
npm run start        # 通过 scripts/start.sh 启动（含 screen 守护）
npm run stop         # 停止 screen 守护进程
```

## 环境变量

### 必填

| 变量 | 说明 |
|------|------|
| `LLM_PROVIDER` | LLM provider（`anthropic` \| `custom` \| `deepseek` \| `minimax` \| `gemini` \| `openrouter`） |

至少配置对应 provider 的 API Key，例如 `ANTHROPIC_API_KEY`、`CUSTOM_API_KEY`、`DEEPSEEK_API_KEY` 等。

### 可选

| 变量 | 说明 |
|------|------|
| `LLM_MODEL` | 覆盖默认模型名 |
| `CUSTOM_VISION_MODEL` | Custom provider 图片描述模型，默认沿用 `CUSTOM_MODEL` |
| `CUSTOM_MODELS` | Custom provider 模型白名单，逗号分隔；用于 `/model list` 展示与模型名匹配 |
| `SHOW_THINKING` | 显示 AI 思考过程和工具调用日志，默认 `true` |
| `MAX_TOOL_ROUNDS` | 单次对话 agentic loop 工具调用轮次上限，默认 `30` |
| `SAMATA_PLUGINS_DIR` | Plugin 目录（逗号分隔多路径），默认 `../samata-plugins` |
| `CLI_API_PORT` | CLI API server 监听端口，默认 `3457` |
| `LANGFUSE_ENABLED` | 开启 agentchat 只读观测，默认 `false` |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | Langfuse 项目凭证与实例地址 |
| `LANGFUSE_TRACING_ENVIRONMENT` | Langfuse 环境名，如 `production` / `staging` |
| `LANGFUSE_CAPTURE_CONTENT` | 是否上传对话和工具正文，默认 `false`，仅上传结构化元数据/token/耗时 |
| `LANGFUSE_CAPTURE_SYSTEM_PROMPT` | 是否上传 system prompt，默认 `false`，且仅在 `LANGFUSE_CAPTURE_CONTENT=true` 时生效 |
| `LANGFUSE_EXPORT_MODE` | Langfuse span 导出模式：`batched` / `immediate`，默认 `batched` |

### 本地 Langfuse

`docker-compose.langfuse.yml` 提供本地 Langfuse self-host 部署，默认只监听 `127.0.0.1`：

```bash
cp .env.langfuse.example .env.langfuse
# 修改 .env.langfuse 中的 change-me，或使用本仓库的本地初始化脚本/命令生成
docker compose --env-file .env.langfuse -f docker-compose.langfuse.yml up -d
```

启动后打开 `http://127.0.0.1:3001`。Samata 只需要配置本地地址和项目 key：

如需远程访问，设置 `.env.langfuse` 中的 `LANGFUSE_BIND_ADDRESS=0.0.0.0`，并把 `NEXTAUTH_URL` 改为远程机器可访问的地址，例如 `http://10.49.9.185:3001`。

```env
LANGFUSE_ENABLED=true
LANGFUSE_BASE_URL=http://127.0.0.1:3001
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_CAPTURE_CONTENT=false
```

Samata 不需要 Dockerfile 改动；Langfuse 只是外部观测端点。默认不会上传对话正文、工具输入输出正文或 system prompt。

### LLM Provider 配置

| Provider | Key 变量 | Base URL 变量 | Model 变量 |
|----------|---------|--------------|-----------|
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `ANTHROPIC_MODEL` |
| Custom（OpenAI-compatible） | `CUSTOM_API_KEY` | `CUSTOM_BASE_URL` | `CUSTOM_MODEL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `DEEPSEEK_MODEL` |
| MiniMax | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL` | `MINIMAX_MODEL` |
| Gemini | `GEMINI_API_KEY` | `GEMINI_BASE_URL` | `GEMINI_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | `OPENROUTER_MODEL` |

### 数据服务（按需）

| 变量 | 说明 |
|------|------|
| `PG_WIND_*` | PostgreSQL Wind 数据 |
| `SERPER_API_KEY` | Google Search API |

## 命令列表

输入非命令文本时，自动转交 AI 助手以自然语言处理（agentic chat）。

### 所有用户

| 命令 | 说明 |
|------|------|
| `/faq <关键词>` | 查询知识库 |
| `/faq-add <内容>` | 添加 FAQ |
| `/skill <list\|save\|run\|del>` | 自定义技能管理 |
| `/agent <list\|create\|switch\|info\|del\|member\|assign\|bot-app\|...>` | Agent 管理 |
| `/memory <list\|add\|search\|del>` | Memory 管理 |
| `/plugin <list\|run>` | 插件管理 |
| `/model <list\|provider/model>` | 切换 LLM Provider/模型 |
| `/status` | 系统状态 |
| `/help` | 显示帮助 |
| `/reset` | 重置当前会话 |

### 管理员专用

| 命令 | 说明 |
|------|------|
| `/bot <tg\|feishu> <start\|stop\|status>` | Bot 进程管理 |
| `/user <list\|add\|update\|delete>` | 系统用户管理 |
| `/reload` | 热重载应用 |

## 项目结构

```
samata/
├── config/agents/        # Agent prompt 文件（*.md）
│   └── _default.md       # 默认 fallback prompt
├── data/
│   ├── samata.db         # 主数据库（自动创建）
│   └── plugins/          # Plugin 私有数据
├── logs/                 # 运行日志
├── packages/plugin-sdk/  # Plugin SDK（类型定义）
├── scripts/
│   ├── start.sh          # 后台启动脚本
│   └── launcher.sh       # 热重载 wrapper
├── src/
│   ├── index.ts          # 服务端入口
│   ├── auth/             # 认证与 RBAC
│   ├── cli/              # CLI 客户端（REPL + SSE 解析）
│   ├── commands/         # 命令处理器（可复用业务函数）
│   ├── db/               # Schema、migrations、seed
│   ├── feishu/           # 飞书 Bot
│   ├── llm/             # AI agent + 多 LLM provider
│   ├── plugins/          # 插件注册与加载
│   ├── runtime/          # execution-context（AsyncLocalStorage）
│   ├── server/           # CLI API server（HTTP/SSE）
│   ├── services/         # reminder-scheduler、mcp-manager
│   ├── shared/           # cli-contract.ts（客户端/服务端共享类型）
│   ├── telegram/         # Telegram Bot
│   ├── tools/            # Tool handler 包装层
│   ├── utils/            # 日志、表格渲染
│   └── wework/           # 企微 Bot
├── .env                  # 环境变量配置
└── .samata.pid           # 运行时 PID 文件
```

## 技术栈

- TypeScript + Node.js（ESM）
- SQLite（better-sqlite3，WAL 模式）
- 多 LLM Provider：Anthropic Claude、DeepSeek、Gemini、MiniMax、OpenRouter、Custom OpenAI-compatible 网关
- Bot SDK：@larksuiteoapi/node-sdk（飞书）
- MCP：@modelcontextprotocol/sdk
- Plugin 系统：独立 repo + `@samata-platform/plugin-sdk`
- pino（结构化日志）
- puppeteer（markdown-to-image）
- undici（HTTP 客户端）

## FAQ

**Q: 如何切换 LLM 模型？**

```
/model list                           # 查看可用 provider 和模型
/model custom/custom-model            # 切换到自定义模型
/model reset                          # 恢复全局默认
```

**Q: 如何添加用户？**

飞书/企微用户首次与 Bot 对话时自动创建。手动设为 agent 管理员：
```
/agent member add <agent_id> <user_id> admin
```

**Q: 服务器重启后数据会丢失吗？**

不会。所有数据持久化在 `data/samata.db`（SQLite），重启后自动恢复。

## License

ISC
