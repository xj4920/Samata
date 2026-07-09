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

空白数据库启动时只会自动创建最小平台基线：

| Agent ID | 中文名 | 来源 | 说明 |
|----------|--------|------|------|
| admin | 系统管理员 | 系统默认自举 | CLI 系统管理、生产 bootstrap、平台级运维 |

生产业务 agent 不再由 `schema.ts` 自动 seed，应通过本地 bootstrap 配置显式创建：

| Agent ID | 中文名 | 来源 | 说明 |
|----------|--------|------|------|
| ticlaw | TIClaw | `config/production-bootstrap.local.json` | Titans / Libra 体系生产问题定位与研发工具助手 |
| otcclaw | OTCClaw | `config/production-bootstrap.local.json` | OTC 业务、交易数据、定价与客户工具助手 |

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

### 空白项目启动

空白项目指新 clone、空 `data/`、尚无 `data/samata.db` 的环境。首次启动只会创建平台最小基线：`admin-001/admin` 用户、`agent-admin/admin` agent，以及 `admin-001` 对 admin agent 的管理员权限；不会自动创建 `ticlaw`、`otcclaw` 或其它业务 agent。

本地开发最小启动：

```bash
npm install
cp .env.example .env
# 编辑 .env，至少配置 LLM_PROVIDER 和对应 provider 的 API Key
npm run server

# 新开终端
npm run cli
```

生产或类生产环境建议用本地忽略配置完成 bootstrap：

```bash
cp config/production-bootstrap.example.json config/production-bootstrap.local.json
# 编辑 config/production-bootstrap.local.json：
# - agents 只配置 ticlaw / otcclaw；admin agent 由系统默认自举，不要写入该文件
# - 填写 ticlaw / otcclaw 的 tools、成员与权限
# - 填写 admin / ticlaw / otcclaw 三个企微 bot，可直接写本地值，也可保留 ${ENV_NAME} 并在 shell 中 export
```

`--dry-run` 需要数据库文件已存在。空白环境可先启动一次 server 或 Docker 容器完成 schema 初始化，再停止服务执行 bootstrap：

```bash
npx tsx scripts/bootstrap-production.ts \
  --config config/production-bootstrap.local.json \
  --dry-run \
  --json

npx tsx scripts/bootstrap-production.ts \
  --config config/production-bootstrap.local.json \
  --apply
```

`--apply` 会在写入前备份 `data/samata.db`，并按配置创建/更新 `ticlaw`、`otcclaw`、企微 bot、成员、tools 与权限，同时清理非目标 agent 和非目标运行期绑定。真实企微 secret 只能放在 `config/production-bootstrap.local.json` 或环境变量中，不要提交。

Docker 空白部署：

```bash
# 目录建议位于同一个 source/ 下
# source/
#   samata/
#   samata-plugins/
#   samata-plugin-work/

sudo mkdir -p /opt/samata/data /opt/samata/logs
sudo chown -R "$USER:$USER" /opt/samata
cp .env.example /opt/samata/.env
chmod 600 /opt/samata/.env
# 编辑 /opt/samata/.env，配置 LLM、插件目录、外部数据与观测端点

npm run docker:otcclaw:build
npm run docker:otcclaw:up
curl http://127.0.0.1:3457/health
```

Docker Compose 对外服务名和容器名为 `otcclaw`，内部应用路径仍是 `/app/samata`。默认从 `/opt/samata/.env` 只读挂载生产配置，并把运行数据、日志写到 `/opt/samata/data`、`/opt/samata/logs`；如需换目录，可设置 `SAMATA_DEPLOY_ROOT`。

发布 OtcClaw 镜像前，先把当前运行数据生成 baseline。SQLite baseline 是完整运行库克隆，包含 bot secret、成员绑定、memory、knowledge、documents 和 telemetry；data files baseline 会打包 `documents/`、`wiki/`、`plugins/`、`dreams/`，用于全新部署目录首次启动时恢复 agent 文件数据。两类 baseline 都只允许进入受控 Docker registry，不提交到 Git：

```bash
npm run baseline:refresh
OTCCLAW_IMAGE_REPO=dockertest.gf.com.cn/titans/otcclaw npm run docker:otcclaw:push
```

默认推送 tag 对齐 Code 制品库版本格式：`v<package.version>-<MMddHHmmssSSS>`，例如 `v3.0.21-0706151315996`。如需额外兼容旧部署入口，可设置 `OTCCLAW_PUSH_ALIASES=1` 同时推送 `<package.version>` 和 `latest` 别名。

部署机同时拉取并启动 OtcClaw 与内网 Langfuse 镜像：

```bash
docker login dockertest.gf.com.cn
cp .env.langfuse.example .env.langfuse
# 编辑 /opt/samata/.env、/opt/samata/mcp-servers.json 和 .env.langfuse
OTCCLAW_IMAGE_TAG=v<package.version>-<MMddHHmmssSSS> npm run docker:otcclaw:deploy
```

如果 Docker build 拉取基础镜像时报 `proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused`，说明 Docker daemon 配置了本机代理但该端口没有服务。检查 `/etc/systemd/system/docker.service.d/http-proxy.conf`，启动本机代理、改成可达代理，或移除 daemon 代理配置后重启 Docker。

批量导入文档时必须指定目标 agent，避免导入到默认 agent：

```bash
npx tsx scripts/import-xbase.ts <xbase_dir> --agent otcclaw
npx tsx scripts/import-xbase.ts <xbase_dir> --agent ticlaw
```

也可以用 `SAMATA_AGENT` 作为环境默认值；未提供 `--agent` 且无 `SAMATA_AGENT` 时脚本会直接失败。导入进度文件按 agent 隔离，形如 `data/import-xbase-state.otcclaw.json`。

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

### 配置生产 Agent（以 ticlaw 为例）

`ticlaw` 不由空白启动自动创建，也不建议通过交互命令零散配置。生产环境应在 `config/production-bootstrap.local.json` 中声明 `ticlaw` agent、企微 bot、成员、tools 和普通成员权限。

最小流程：

```bash
cp config/production-bootstrap.example.json config/production-bootstrap.local.json
# 编辑 agents 中 name=ticlaw 的配置：
# - toolsList / blockTools
# - userToolsMode / userToolsList
# - members
# 编辑 weworkBots 中 agent=ticlaw 的 bot id / secret / autoStart

npx tsx scripts/bootstrap-production.ts \
  --config config/production-bootstrap.local.json \
  --dry-run \
  --json

npx tsx scripts/bootstrap-production.ts \
  --config config/production-bootstrap.local.json \
  --apply
```

`admin` agent 由系统默认自举，不要写入 production bootstrap 的 `agents` 数组；`admin` 的企微 bot 可以保留在 `weworkBots` 中绑定。详细部署边界参见 [部署与模型](docs/platform/deployment.md)，本次 schema/bootstrap 清理记录见 [Schema Seed 清理与生产 Bootstrap 脚本](docs/plan/2026-06-10_schema-seed-production-bootstrap.md)。

### Agent 加 Tool SOP

插件工具是否对某个 Agent 可见，由插件 scope 和 Agent 的工具配置共同决定。`universal` 插件默认进入标准 Agent 工具池；`agent-bound` 插件必须把工具名加入目标 Agent 的 `tools_list`，普通成员权限再由 `user_tools_list` 控制。不要为业务插件工具在 `src/db/schema.ts` 新增 migration。

标准流程：

1. 确认插件已加载：启动日志应出现 `Plugin [name]: N tools loaded`，且插件 `toolDefinitions` 中包含目标工具名。
2. 确认插件 scope：`agent-bound` 需要绑定到具体 Agent；`universal` 通常不需要额外绑定。
3. 先 dry-run 预览工具差异：

   ```bash
   npx tsx scripts/bind-agent-tools.ts \
     --agent otcclaw \
     --add sync_normal_trading_position_details,query_normal_trading_position_details_csv \
     --member-block sync_normal_trading_position_details \
     --user admin \
     --dry-run \
     --json
   ```

4. 判断 member blocklist：同步、导入、删除、高成本刷新等写入类工具加入 `--member-block`；只读查询和只读计算通常只放入 `--add`。
5. 确认 dry-run 符合预期后，去掉 `--dry-run --json` 执行绑定。
6. 验证绑定结果：用 `get_agent`、`/agent info` 或只读查询 `agents.tools_list / user_tools_list`，分别确认 Agent admin 与普通成员可见工具符合预期。

生产 bootstrap 配置也要同步维护：在 `config/production-bootstrap.local.json` 的目标 Agent `toolsList` 中加入新增工具；需要限制普通成员时，同步加入 `userToolsList`。仓库中的 `config/production-bootstrap.example.json` 仅提供示例和回归参考，真实 secret 与本地成员配置不要提交。

### 其他启动方式

```bash
npm run dev          # 开发模式（tsx watch，单进程 REPL）
npm run telegram     # 单独启动 Telegram Bot 进程
npm run wework       # 单独启动企微 Bot 进程
npm run start        # 通过 scripts/start.sh 启动（含 screen 守护）
npm run stop         # 停止 screen 守护进程
```

## 协作流程

所有功能需求、Bug 修复、架构调整、文档治理和 Agent 开发任务都应先创建 Issue，并使用仓库内的中文模板：

- Issue 模板：`.gitee/ISSUE_TEMPLATE.zh-CN.md`
- 中大型变更需先完成需求澄清和方案确认，再进入开发
- MR 需关联对应 Issue，并说明修改范围、验证结果和风险
- 使用 Agent 参与开发时，提交人需 review Agent 产物，并对最终变更负责

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

生产/测试部署可通过 `LANGFUSE_*_IMAGE` 覆盖为 dockertest 镜像；`scripts/deploy-otcclaw.sh` 默认使用 `dockertest.gf.com.cn/titans/otcclaw-langfuse-*` 这一组镜像名。

启动后打开 `http://127.0.0.1:3001`。Samata 只需要配置本地地址和项目 key：

如需远程访问，设置 `.env.langfuse` 中的 `LANGFUSE_BIND_ADDRESS=0.0.0.0`，并把 `NEXTAUTH_URL` 改为远程机器可访问的地址，例如 `http://10.49.9.185:3001`。

```env
LANGFUSE_ENABLED=true
LANGFUSE_BASE_URL=http://127.0.0.1:3001
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_CAPTURE_CONTENT=false
```

OtcClaw 主镜像不打包 Langfuse；Langfuse 只是外部观测端点。默认不会上传对话正文、工具输入输出正文或 system prompt。

### LLM Provider 配置

| Provider | Key 变量 | Base URL 变量 | Model 变量 |
|----------|---------|--------------|-----------|
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `ANTHROPIC_MODEL` |
| Custom（OpenAI-compatible） | `CUSTOM_API_KEY` | `CUSTOM_BASE_URL` | `CUSTOM_MODEL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `DEEPSEEK_MODEL` |
| MiniMax | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL` | `MINIMAX_MODEL` |
| Gemini | `GEMINI_API_KEY` | `GEMINI_BASE_URL` | `GEMINI_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | `OPENROUTER_MODEL` |

### 数据服务与生产 bootstrap（按需）

| 变量 | 说明 |
|------|------|
| `PG_WIND_*` | PostgreSQL Wind 数据 |
| `SERPER_API_KEY` | Google Search API |

`config/production-bootstrap.example.json` 中的企微 bot secret 可以用 `${WEWORK_ADMIN_SECRET}` 这类环境变量占位；执行 `scripts/bootstrap-production.ts` 时会读取当前 shell 环境展开。不要把 `config/production-bootstrap.local.json`、真实 bot id 或 secret 提交到仓库。

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
├── docker-baseline/       # Docker baseline 模板目录（*.db / data-files.tar.gz 本地生成，不提交）
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
│   ├── db/               # DDL、自举与 Umzug migrations
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
