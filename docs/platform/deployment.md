# 部署与模型

本地部署以 Node.js、SQLite 和配置文件为核心。生产或团队环境可以把插件目录、Agent prompt、Bot app 凭证和外部数据连接分开管理。

## 本地启动

```bash
npm install
cp .env.example .env
npm run server
npm run cli
```

## 数据库迁移与 Seed 边界

启动期会先执行 legacy `initSchema()`，用于基础建表和历史 `runOnce` 迁移；随后执行 Umzug migration runner。新增数据库迁移一律放在 `src/db/migrations/`，不要继续追加到 `src/db/schema.ts`。

```bash
npm run db:migrate
```

`npm run db:migrate` 复用 SQLite `migrations` 表记录执行状态，适合本地或部署前显式验证。默认 Agent / 默认成员这类平台基线仍由 legacy 初始化保证；开发、演示、业务插件绑定和 Bot 配置不应作为启动 seed 写入平台 schema。

## Bot 配置

飞书、企微和 Telegram Bot 配置以 SQLite `bot_apps` 和 `agent_assignments` 为准，通过 CLI 的 `/agent bot-app`、`/agent assign`、`/agent bot-app start|stop` 管理。`WEWORK_AIBOT_*` 不再作为自动写入 `bot_apps` 的入口；需要启用企微 Bot 时，先显式创建/绑定 Bot app，再启动服务或独立企微进程。

## Docker 部署

Docker 镜像会同时打包 Samata 主应用和同级目录下的源码插件：

```text
source/
  samata/
  samata-plugins/
  samata-plugin-work/
```

从 `samata/` 目录启动：

```bash
sudo mkdir -p /opt/samata/data /opt/samata/logs
sudo chown -R "$USER:$USER" /opt/samata
cp .env.example /opt/samata/.env
chmod 600 /opt/samata/.env
# 编辑 /opt/samata/.env，配置 LLM Provider、插件和外部服务密钥；Bot app 凭证通过 CLI 写入 SQLite
npm run docker:samata:up
docker compose --env-file /dev/null logs -f samata
```

Samata 容器通过只读挂载读取 `/opt/samata/.env`，并把 SQLite 数据和日志持久化到 `/opt/samata/data`、`/opt/samata/logs`。`scripts/docker-samata.sh` 默认检查 `/opt/samata/.env` 是否存在；如需使用其他运行目录，可设置 `SAMATA_DEPLOY_ROOT=/path/to/samata-runtime`。`--env-file /dev/null` 只是避免 Docker Compose 把项目根 `.env` 当成 compose 插值文件解析，尤其适合 `.env` 中密码包含 `$` 的情况。

镜像内 `/app/samata/config/agents` 会在构建和启动时授权给 `node` 用户，系统管理员可通过 CLI 工具创建或编辑 Agent prompt 文件。默认 compose 不持久化该目录，容器内临时创建的 prompt 会随着容器重建丢失；生产 Agent prompt 仍应提交到仓库的 `config/agents/<agent-name>.md` 并重新构建/部署镜像。Agent prompt 文件名按 `agent.name` 精确匹配；交互式 `/agent create` 要求小写英文名称，例如显示名可为 `OtcmsClaw`，但 name 和文件建议为 `otcmsclaw` / `config/agents/otcmsclaw.md`。

`npm run docker:samata:up` 会从 `package.json` 读取版本号并生成主 tag：`samata:<version>-<git-sha>`；同时打上 `samata:<version>` 和 `samata:latest` 两个别名。需要只构建不启动时使用 `npm run docker:samata:build`；清理 `<none>:<none>` dangling 镜像时使用 `npm run docker:samata:prune`。

### 推送到 Code 平台制品库

Samata 镜像发布脚本支持把同一套版本 tag 推送到 Code 平台制品库。制品库地址以 Code 平台项目页面展示为准，脚本不会在仓库中保存 registry 账号、密码或 token；发布前需要在本机先完成 Docker 登录。

```bash
docker login <code-registry-host>
SAMATA_IMAGE_REPO=<code-registry-host>/<namespace>/samata npm run docker:samata:push
```

`docker:samata:push` 会先执行一次镜像构建，再推送三个 tag：

```text
<code-registry-host>/<namespace>/samata:<version>-<git-sha>
<code-registry-host>/<namespace>/samata:<version>
<code-registry-host>/<namespace>/samata:latest
```

如果工作区存在未提交改动，主 tag 会追加 `dirty-YYYYMMDDHHMMSS`，用于避免覆盖同一个版本 sha tag。生产发布建议使用干净工作区构建；如需固定发布 tag，可显式设置 `SAMATA_IMAGE_TAG`。脚本会拒绝在未设置 `SAMATA_IMAGE_REPO` 时执行 push，避免把默认本地镜像名误推到公共 registry。

部署机需要拉取 Code 制品库镜像时，使用同一个 `SAMATA_IMAGE_REPO` 和目标 `SAMATA_IMAGE_TAG`：

```bash
docker login <code-registry-host>
SAMATA_IMAGE_REPO=<code-registry-host>/<namespace>/samata \
SAMATA_IMAGE_TAG=<version>-<git-sha> \
docker compose --env-file /dev/null pull samata

SAMATA_IMAGE_REPO=<code-registry-host>/<namespace>/samata \
SAMATA_IMAGE_TAG=<version>-<git-sha> \
docker compose --env-file /dev/null up -d --no-build samata
```

容器内 Samata 监听 `0.0.0.0:3457`，宿主机可访问：

```bash
curl http://127.0.0.1:3457/health
CLI_SERVER_URL=http://127.0.0.1:3457 npm run cli
```

`docker-compose.yml` 使用父目录 `..` 作为 build context，并通过 `Dockerfile.dockerignore` 只允许 `samata/`、`samata-plugins/` 和 `samata-plugin-work/` 进入构建上下文。`.env`、`data/`、`logs`、`node_modules/` 和本地 `samata-plugin-work/logyi-mcp/` 不会打进镜像；运行时会只读挂载 `/opt/samata/.env`，并挂载 `/opt/samata/data` 和 `/opt/samata/logs`。公共插件源码会复制到镜像内的 `/app/plugins`，工作区插件会复制到镜像内的 `/app/work-plugins`，并通过 `SAMATA_PLUGINS_DIR=/app/plugins,/app/work-plugins` 加载。LogYi MCP 通过 `config/mcp-servers.json` 使用公司 npm 仓库的 `@gf/logyi-mcp@latest` 启动，不依赖本地 `samata-plugin-work/logyi-mcp`。

多个 Agent 需要使用不同 LogYi 凭据时，在 `config/mcp-servers.json` 中配置多个 MCP server 实例，并为每个实例设置 `kind: "logyi"` 和对应 `agents` 白名单。`kind: "logyi"` 会让所有 LogYi 实例复用同一套时间范围护栏；server name 决定工具名前缀，例如 `logyi` 暴露 `mcp_logyi_*`，`logyiotcmsclaw` 暴露 `mcp_logyiotcmsclaw_*`。密钥只放在 `/opt/samata/.env`，仓库配置只引用变量名，例如：

```bash
TICLAW_LOGYI_BASE_URL=http://log.gf.com.cn
TICLAW_LOGYI_USERNAME=...
TICLAW_LOGYI_API_KEY=...

OTCMSCLAW_LOGYI_BASE_URL=http://log.gf.com.cn
OTCMSCLAW_LOGYI_USERNAME=...
OTCMSCLAW_LOGYI_API_KEY=...
```

镜像内会准备 sandbox 基础运行环境：Node.js 22、系统 Python 3、`python`/`python3`、pip、venv、bubblewrap 隔离工具，以及 sandbox 工具说明中声明的常用 Python 数据处理依赖（`psycopg2`、`pandas`、`numpy`、`matplotlib`、`openpyxl`、`xlrd`、`requests`、`beautifulsoup4`、`lxml`、`pillow`、`paramiko`、`cryptography`）。sandbox 代码会优先使用 `SANDBOX_PYTHON_BIN` 或 `SANDBOX_PYTHON_ROOT` 指定的 Python；容器中默认自动落到系统 Python。

Docker 默认权限通常不允许 bubblewrap 创建命名空间。Samata 会真实试跑 bubblewrap，只有可用时才启用文件系统隔离；不可用时自动退回普通执行，保证 Python/Node sandbox 任务能跑。若生产环境必须强隔离，需要单独评估并显式提高容器权限（例如 privileged 级别），不建议作为默认 compose 配置。

生产环境默认不提供 Chromium/Chrome DevTools 浏览器工具。`NODE_ENV=production` 时 Samata 会跳过 `devtools` MCP，不注册 `mcp_devtools_*`，并从 Agent prompt 中移除浏览器工具说明，避免在生产网络不可达时反复调用浏览器。特殊环境确实需要启用时可显式设置 `SAMATA_ENABLE_CHROMIUM_TOOLS=1`；开发环境需要禁用时可设置 `SAMATA_DISABLE_CHROMIUM_TOOLS=1`。

Wind、Fast Trading、Log 相关数据由本机已有的 `wind_sync_pg` Postgres 容器提供，该容器由外部 crontab 每日更新。Samata compose 会加入外部 Docker 网络 `samata-wind-sync`，并把 `PG_WIND_HOST`、`FAST_TRADING_PG_HOST`、`WIND_PG_HOST`、`LOG_PG_HOST` 指向 `wind_sync_pg`，避免再维护一份不同步的 compose 内部空库。

首次部署前需要准备共享网络，并把 `wind_sync_pg` 接入该网络：

```bash
docker network create samata-wind-sync || true
docker network connect --alias wind_sync_pg samata-wind-sync wind_sync_pg || true
```

`/opt/samata/.env` 通过只读挂载提供给容器内应用，由 Samata 启动时的 dotenv 加载，不会进入镜像。不要把 `.env` 配成 compose `env_file`，密钥中如果包含 `$` 可能会被 Compose 当变量插值处理。`environment` 中显式配置的容器内地址会覆盖 `.env` 里的本地开发地址。

容器内访问内网 LLM 网关需要使用企业 DNS。compose 已为 Samata 配置 `10.55.66.66`、`10.80.66.66`，避免 Docker 默认 DNS 无法解析 `llm.smart-zone-dev.gf.com.cn`。

本地 Langfuse 不打进 Samata 镜像，继续使用 `docker-compose.langfuse.yml` 的独立服务。Samata 容器内访问本地 Langfuse 时使用 `http://langfuse-web:3000`，compose 已覆盖 `LANGFUSE_BASE_URL`；宿主机浏览器仍访问 `http://127.0.0.1:3001`。

Docs 不随 Samata 主服务默认启动。需要容器内预览文档时运行：

```bash
docker compose --env-file /dev/null --profile docs up -d docs
```

文档站：

```bash
npm run docs:dev
```

局域网预览：

```bash
npm run docs:dev -- --host 0.0.0.0
```

## 模型配置

通过 `LLM_PROVIDER` 选择 provider，并配置对应 API key、base URL 和模型名。Custom、DeepSeek、Gemini、MiniMax、OpenRouter、Anthropic provider 走统一接口。

BigModel / GLM 图片识别使用 `custom` provider 的 OpenAI-compatible 接口：

```bash
LLM_PROVIDER=custom
CUSTOM_API_KEY=your-bigmodel-key
CUSTOM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
CUSTOM_MODEL=glm-5
CUSTOM_VISION_MODEL=glm-5v-turbo
CUSTOM_MODELS=glm-5,glm-5v-turbo
```

其中 `CUSTOM_VISION_MODEL` 用于图片消息、文档导入中的图片转录等识图场景。

如果购买的是 GLM-OCR 资源包，需额外启用 BigModel OCR。Samata 会在图片预处理和文档图片转录时优先调用 `glm-ocr` 的 `layout_parsing` 接口，失败后再回退到其他 vision provider：

```bash
BIGMODEL_API_KEY=your-bigmodel-key
BIGMODEL_OCR_BASE_URL=https://open.bigmodel.cn/api/paas/v4
BIGMODEL_OCR_MODEL=glm-ocr
BIGMODEL_OCR_ENABLED=true
```

`CUSTOM_VISION_MODEL=glm-5v-turbo` 走的是通用多模态聊天接口，不等同于 GLM-OCR 资源包。

## Agent 示例

Moss 这类轻量 Agent 的部署流程包括：创建 prompt、创建 Agent、配置成员、绑定 Bot 渠道。原始实施记录见 [Moss Agent 部署演进记录](../plan/2026-05-25_moss-deployment-guide.md)。
