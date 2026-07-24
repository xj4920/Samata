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

sudo install -d -m 0775 -o "$USER" -g "$(id -gn)" \
  /opt/samata /opt/samata/data /opt/samata/logs
sudo install -d -m 0700 -o "$USER" -g "$(id -gn)" /opt/samata/ssh
# 仅限无历史业务数据的全新部署；已有旧 Samata 业务库时改用迁移脚本创建。
sudo install -d -m 0700 -o 999 -g 999 /opt/samata/data/postgres
cp .env.example .env
cp .env.langfuse.example .env.langfuse
chmod 600 .env .env.langfuse
cp config/mcp-servers.example.json /opt/samata/mcp-servers.json
chmod 600 /opt/samata/mcp-servers.json
# 编辑 .env 与 .env.langfuse；它们只用于生成 Compose，不挂载进容器。

npm run docker:otcclaw:up
curl http://127.0.0.1:3457/health
```

仓库 `docker-compose.yml` 是带 `{{string "..."}}` 的生产平台模板，不可直接运行。
`npm run compose:render` 会读取仓库本地 `.env`、`.env.langfuse`，校验后原子生成
`/opt/samata/docker-compose.yml`。生成文件包含 OtcClaw 和完整 Langfuse 栈，不包含
docs；运行时不挂载 `.env`。PostgreSQL 使用
`/opt/samata/data/postgres:/var/lib/postgresql/data`，OtcClaw 的 data、logs、SSH 和 MCP
挂载也全部固定在同一 Compose 中。OtcClaw 内部再用只读空卷遮蔽
`/app/samata/data/postgres`，避免入口脚本访问或递归改权 PGDATA。PGDATA 创建后不要再对
`/opt/samata/data` 执行递归 `chown`。

生成文件可以在 `/opt/samata` 直接执行 Docker Compose；但直接命令不参与仓库脚本的
共享部署锁，迁移、`deploy-otcclaw.sh` 或 `docker-samata.sh up` 正在运行时禁止并发
执行。`docker-samata.sh build/push/prune` 只操作镜像，不持有运行时部署锁。日常部署
优先使用仓库脚本入口。

发布 OtcClaw 镜像前，先把当前运行数据生成 baseline。SQLite baseline 是完整运行库克隆，包含 bot secret、成员绑定、memory、knowledge、documents 和 telemetry；data files baseline 会打包 `documents/`、`wiki/`、`plugins/`、`dreams/`，用于全新部署目录首次启动时恢复 agent 文件数据。两类 baseline 都只允许进入受控 Docker registry，不提交到 Git：

```bash
npm run baseline:refresh
DOCKER_REPO=dockertest.gf.com.cn npm run docker:otcclaw:push
```

默认推送 tag 对齐 Code 制品库版本格式：`v<package.version>-<MMddHHmmssSSS>`，例如 `v3.0.21-0706151315996`。如需额外兼容旧部署入口，可设置 `OTCCLAW_PUSH_ALIASES=1` 同时推送 `<package.version>` 和 `latest` 别名。

部署机同时拉取并启动 OtcClaw 与内网 Langfuse 镜像：

```bash
docker login dockertest.gf.com.cn
cp .env.example .env
cp .env.langfuse.example .env.langfuse
# 编辑 .env、.env.langfuse 和 /opt/samata/mcp-servers.json
# 全新部署先按上文创建 PGDATA；已有 wind_sync_pg/samata 先 render 并执行迁移脚本。
IMAGE_VERSION=v<package.version>-<MMddHHmmssSSS> npm run docker:otcclaw:deploy
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
| `LANGFUSE_CAPTURE_CONTENT` | 是否上传对话和工具正文；代码默认 `false`，生产 Compose 固定为 `true` |
| `LANGFUSE_CAPTURE_SYSTEM_PROMPT` | 是否上传 system prompt，默认 `false`，且仅在 `LANGFUSE_CAPTURE_CONTENT=true` 时生效 |
| `LANGFUSE_EXPORT_MODE` | Langfuse span 导出模式：`batched` / `immediate`，默认 `batched` |

### 本地 Langfuse

Langfuse 已合并进生产模板，Web 端口监听所有宿主机网络接口
`0.0.0.0:3001`：

```bash
cp .env.langfuse.example .env.langfuse
# 修改所有 change-me
npm run compose:render
cd /opt/samata
docker compose --env-file /dev/null up -d --no-build
```

启动后在宿主机打开 `http://127.0.0.1:3001`，或从受信网络访问
`http://<宿主机 IP>:3001`。该端口会暴露 Langfuse 登录页，应通过主机防火墙或上游
访问控制限制来源网络。同一组 `LANGFUSE_PUBLIC_KEY` /
`LANGFUSE_SECRET_KEY` 同时用于首次初始化项目和 Samata SDK 写入。Fast/Normal/Hedge
业务表写入同一 PostgreSQL 实例中的独立 `samata` 数据库；Langfuse 自己继续使用
`langfuse` 数据库。新部署不会复用旧 Langfuse PostgreSQL、ClickHouse 或 MinIO 数据：
PostgreSQL 使用 `/opt/samata/data/postgres`，ClickHouse/MinIO 使用带 `v1` 后缀的新命名
卷；旧 `samata_langfuse_*` 卷不挂载、不自动删除。

生产 Compose 开启 `LANGFUSE_CAPTURE_CONTENT=true`，因此新 trace 会保存用户提问、
模型回复以及工具输入输出；`LANGFUSE_CAPTURE_SYSTEM_PROMPT=false` 继续阻止 system
prompt 上传。该配置只影响变更后产生的 trace，历史脱敏内容无法恢复。

### LLM Provider 配置

| Provider | Key 变量 | Base URL 变量 | Model 变量 |
|----------|---------|--------------|-----------|
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `ANTHROPIC_MODEL` |
| Custom（OpenAI-compatible） | `CUSTOM_API_KEY` | `CUSTOM_BASE_URL` | `CUSTOM_MODEL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `DEEPSEEK_MODEL` |
| MiniMax | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL` | `MINIMAX_MODEL` |
| Gemini | `GEMINI_API_KEY` | `GEMINI_BASE_URL` | `GEMINI_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | `OPENROUTER_MODEL` |

### 数据服务、工具策略与生产 bootstrap

| 变量 | 说明 |
|------|------|
| `SAMATA_POSTGRES_PASSWORD` | 新 PostgreSQL 实例中 `samata_app/samata` 的独立密码 |
| `SAMATA_DISABLED_TOOLS` | 全局最终工具禁用列表；生产模板固定禁用 `generate_image,generate_video` |
| `SFTP_HOST` / `SFTP_USER` / `SFTP_PASSWORD` | 所有生产插件共用的 SFTP 地址、用户和密码 |
| `SERPER_API_KEY` | Google Search API |

生产不再配置或访问 Wind PostgreSQL，也不再提供通用 Wind 数据库查询能力。
`analyze_sbl_usage` 直接使用 SFTP `borrow_YYYYMMDD.csv` 与 `trades_YYYYMMDD.csv` 中的
`close_price` 计算市值；旧缓存缺少该列时由 SBL 插件自动重新下载。生产 Compose 不声明
`WIND_PG_*`、Wind reader、Wind 检查服务或外部 Wind 网络。

历史 `wind_sync_pg/samata` 业务库可先通过 `npm run postgres:migrate:dry-run` 检查，
再在确认停写窗口后执行 `bash scripts/migrate-samata-postgres.sh --execute`。迁移工具只读取
该历史 `samata` 数据库，不访问同一源实例中的其它数据库。它会先拉取并 inspect 目标镜像，
持有 `/opt/samata` 目录锁，固定使用权限为 `0600` 的 Compose 快照，并只清理本次认领且
没有容器引用的未使用新卷。恢复完成后等待 OtcClaw `/health` 通过；失败时不会启动或保留
不健康的 OtcClaw。源容器、源数据、dump 和旧 Langfuse volumes 均保留。

截至 2026-07-21，现场已完成历史 `wind_sync_pg/samata` 到 fresh Langfuse PostgreSQL
`samata` 数据库的迁移，当前 PGDATA 绑定 `/opt/samata/data/postgres`。该旧容器仅作为
保留的历史迁移源，不属于 Samata 运行时依赖。

### 每日会话审计

生产 Compose 使用独立的 `session-audit` sidecar，不依赖宿主机 crontab，也不依赖
Langfuse Web/Worker。sidecar 每日北京时间 23:30 审计 `ticlaw`、`otcclaw` 当日来自
企微、飞书、Telegram 的人工会话，并写入 `langfuse-postgres` 实例中的独立 `samata`
数据库：

- `samata_user_questions`：按 `turn_id` 幂等保存问题、完整回复、结构化工具调用、耗时、
  token、模型和异常状态；单个问题或回复最多保留 100,000 字符，并记录原始字符数及
  是否截断。
- `samata_session_audit_runs`：按日期、Agent 范围、数据源记录 `running/completed/failed`
  状态和会话数，零会话日期也会落完成记录。
- 每轮先重审前一自然日，再写当日 23:30 快照；次日的前一日重审会补齐 23:30–24:00
  的晚到会话。telemetry 文件按 UTC 分片，分析器会跨相邻分片读取后按北京时间自然日过滤。
- sidecar 每次启动也会幂等补跑前一日和当日，以验证 PostgreSQL 写入链路并修复停机窗口。
- 本地 Markdown 报告写入 `logs/daily_usage/`，权限固定为 `0600`；完整内容仅写入审计表，
  Markdown 只展示摘要。

运行状态可用以下命令检查：

```bash
docker inspect --format '{{.State.Health.Status}}' otcclaw-session-audit
docker logs --tail 100 otcclaw-session-audit
```

首次上线且 sidecar 已为 `healthy` 后，先 dry-run，再备份并删除旧的企微/飞书宿主机
审计 cron。脚本只匹配两条历史 `analyze-log.ts` 任务，不修改其它 cron：

```bash
bash scripts/migrate-session-audit-crontab.sh --dry-run
bash scripts/migrate-session-audit-crontab.sh --execute
```

完整 crontab 备份保存到 `/opt/samata/backups/session-audit-crontab/`。


生产模板严格保留 27 个唯一占位符；`.env.example` 提供 16 项，`.env.langfuse.example`
提供 10 项 Langfuse 必填输入。`NEXTAUTH_URL` 仍是模板占位符，但本地渲染时可省略：
`scripts/render-local-compose.mjs` 会自动检测容器宿主机 IP，生成
`http://<host-ip>:3001`；如果 Langfuse 通过固定域名、负载均衡或反向代理访问，再在
`.env.langfuse` 中显式覆盖。所有值都会进入生成的 `/opt/samata/docker-compose.yml`，
不要提交真实配置。

生产发布平台使用小写占位符 `docker_repo`、`image_version`；本地 `.env` 对应填写
`DOCKER_REPO`、`IMAGE_VERSION`。除 `NEXTAUTH_URL` 的本地自动推导外，其余参数都必须有
明确值：

| 参数 | 分类 | 必填 | 说明 | 参考配置值 |
|------|------|------|------|------------|
| `docker_repo` | 镜像 | 是 | 私有镜像仓库根地址；本地输入名为 `DOCKER_REPO` | `dockertest.gf.com.cn` |
| `image_version` | 镜像 | 是 | OtcClaw 镜像 tag；本地输入名为 `IMAGE_VERSION` | `v3.0.34-0722093000000` |
| `CUSTOM_API_KEY` | Custom 模型 | 是 | Custom/OpenAI-compatible 模型 API Key | `change-me` |
| `CUSTOM_BASE_URL` | Custom 模型 | 是 | Custom 模型 API base URL | `https://api.example.com/v1` |
| `CUSTOM_MODEL` | Custom 模型 | 是 | 生产文本模型 | `external-deepseek-v4-pro` |
| `CUSTOM_VISION_MODEL` | Custom 模型 | 是 | 生产视觉模型 | `vision-model` |
| `SERPER_API_KEY` | 外部服务 | 是 | Web search/Serper API Key | `change-me` |
| `SAMATA_POSTGRES_PASSWORD` | Samata 业务库 | 是 | Langfuse PostgreSQL 实例中 `samata_app/samata` 的密码，不复用 Langfuse 数据库密码 | `openssl rand -hex 32` |
| `SFTP_HOST` | SFTP | 是 | 统一 SFTP 地址，所有生产插件共用 | `10.68.15.21` |
| `SFTP_USER` | SFTP | 是 | 统一 SFTP 用户 | `EQDHK_internal` |
| `SFTP_PASSWORD` | SFTP | 是 | 统一 SFTP 密码 | `change-me` |
| `HEDGE_RATIO_EMAIL_ADDRESS` | Hedge 邮箱 | 是 | Hedge Ratio 邮箱账号 | `titans@example.com` |
| `HEDGE_RATIO_EMAIL_PASSWORD` | Hedge 邮箱 | 是 | Hedge Ratio 邮箱密码或应用专用密码 | `change-me` |
| `HEDGE_RATIO_EMAIL_IMAP_SERVER` | Hedge 邮箱 | 是 | Hedge Ratio 邮箱 IMAP 服务器 | `mail.example.com` |
| `HEDGE_RATIO_EMAIL_IMAP_PORT` | Hedge 邮箱 | 是 | Hedge Ratio 邮箱 IMAP 端口 | `993` |
| `LOGYI_API_KEY` | LogYi | 是 | LogYi API Key；Compose 映射给 TICLAW/OTCMSCLAW 两套 MCP | `change-me` |
| `NEXTAUTH_URL` | Langfuse | 本地可省略 | Langfuse 对外访问地址；本地渲染默认 `http://<容器宿主机 IP>:3001`，生产平台直接渲染模板时建议显式填写 | `http://10.49.9.185:3001` |
| `NEXTAUTH_SECRET` | Langfuse | 是 | NextAuth 会话签名密钥 | `openssl rand -hex 32` |
| `SALT` | Langfuse | 是 | Langfuse 内部加盐密钥 | `openssl rand -hex 32` |
| `REDIS_AUTH` | Langfuse | 是 | Langfuse Redis 密码 | `openssl rand -hex 32` |
| `LANGFUSE_POSTGRES_PASSWORD` | Langfuse | 是 | Langfuse 自身 `langfuse/langfuse` 数据库密码，不复用 `SAMATA_POSTGRES_PASSWORD` | `openssl rand -hex 32` |
| `MINIO_ROOT_PASSWORD` | Langfuse | 是 | Langfuse MinIO root 密码 | `openssl rand -hex 32` |
| `CLICKHOUSE_PASSWORD` | Langfuse | 是 | Langfuse ClickHouse 密码 | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Langfuse | 是 | Langfuse 加密密钥，必须是 64 位十六进制字符串 | `openssl rand -hex 32` |
| `LANGFUSE_PUBLIC_KEY` | Langfuse | 是 | 首次初始化 Langfuse 项目的 public key，同时供 Samata SDK 写入 trace | `pk-lf-samata-...` |
| `LANGFUSE_SECRET_KEY` | Langfuse | 是 | 首次初始化 Langfuse 项目的 secret key，同时供 Samata SDK 写入 trace | `sk-lf-samata-...` |
| `LANGFUSE_INIT_USER_PASSWORD` | Langfuse | 是 | Langfuse 初始管理员密码；管理员邮箱和项目 identity 固定在 Compose | 强密码 |

生产统一外露 `SFTP_HOST`、`SFTP_USER`、`SFTP_PASSWORD` 三项。Compose 固定端口 22
和八个业务目录，各数据集远端目录仍独立，防止 Fast Trading、Normal Trading、
Corporate Action、SBL 和 Hedge 串用。Samata 启动时会在进程内派生现有插件所需的兼容
变量。两个 LogYi MCP 实例也只外露同一个 `LOGYI_API_KEY`，Compose 将其映射到现有两组
兼容环境变量。

`config/production-bootstrap.example.json` 中的企微 bot secret 可以用 `${WEWORK_ADMIN_SECRET}` 这类环境变量占位；执行 `scripts/bootstrap-production.ts` 时会读取当前 shell 环境展开。不要把 `config/production-bootstrap.local.json`、真实 bot id 或 secret 提交到仓库。

## 命令列表

输入非命令文本时，自动转交 AI 助手以自然语言处理（agentic chat）。

### 所有用户

| 命令 | 说明 |
|------|------|
| `/faq <关键词>` | 查询知识库 |
| `/faq-add <内容>` | 添加 FAQ |
| `/faq-update` / `/faq-del` / `/faq-tags-check` | 更新、删除和检查 FAQ 标签 |
| `/doc-import` / `/doc-list` / `/doc-del` / `/doc-retag` | 文档导入、查询、删除和重新标记 |
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

### 开发与校验脚本

```bash
npm run check-readme
npm run analyze-log
npm run docs:plan-sync
npm run docs:plan-watch
npm run docs:dev
npm run docs:build
npm run docs:check
npm run docs:preview
npm run db:migrate
npm run sqlite:baseline:refresh
npm run data:baseline:refresh
npm run docker:otcclaw:build
npm run docker:otcclaw:up
npm run docker:otcclaw:prune
npm run docker:samata:up
npm run docker:samata:build
npm run docker:samata:push
npm run docker:samata:prune
npm run test
npm run test:unit
npm run test:e2e
npm run test:watch
```

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
