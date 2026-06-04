# 部署与模型

本地部署以 Node.js、SQLite 和配置文件为核心。生产或团队环境可以把插件目录、Agent prompt、Bot app 凭证和外部数据连接分开管理。

## 本地启动

```bash
npm install
cp .env.example .env
npm run server
npm run cli
```

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
cp .env.example .env
# 编辑 .env，配置 LLM Provider、Bot 凭证和外部服务密钥
npm run docker:samata:up
docker compose --env-file /dev/null logs -f samata
```

Samata 容器通过只读挂载读取 `./.env`；`--env-file /dev/null` 只是避免 Docker Compose 把项目根 `.env` 当成 compose 插值文件解析，尤其适合 `.env` 中密码包含 `$` 的情况。

`npm run docker:samata:up` 会从 `package.json` 读取版本号并生成主 tag：`samata:<version>-<git-sha>`；同时打上 `samata:<version>` 和 `samata:latest` 两个别名。需要只构建不启动时使用 `npm run docker:samata:build`；清理 `<none>:<none>` dangling 镜像时使用 `npm run docker:samata:prune`。

容器内 Samata 监听 `0.0.0.0:3457`，宿主机可访问：

```bash
curl http://127.0.0.1:3457/health
CLI_SERVER_URL=http://127.0.0.1:3457 npm run cli
```

`docker-compose.yml` 使用父目录 `..` 作为 build context，并通过 `Dockerfile.dockerignore` 只允许 `samata/`、`samata-plugins/` 和 `samata-plugin-work/` 进入构建上下文。`.env`、`data/`、`logs` 和 `node_modules/` 不会打进镜像；运行时会只读挂载 `./.env`，并挂载 `./data` 和 `./logs`。公共插件源码会复制到镜像内的 `/app/plugins`，工作区插件会复制到 `/app/work-plugins`，并通过 `SAMATA_PLUGINS_DIR=/app/plugins,/app/work-plugins` 加载。`samata-plugin-work/logyi-mcp` 是 MCP 服务，不走插件扫描，会单独构建到 `/app/samata-plugin-work/logyi-mcp`。

镜像内会准备 sandbox 基础运行环境：Node.js 22、系统 Python 3、`python`/`python3`、pip、venv、bubblewrap 隔离工具，以及 sandbox 工具说明中声明的常用 Python 数据处理依赖（`psycopg2`、`pandas`、`numpy`、`matplotlib`、`openpyxl`、`xlrd`、`requests`、`beautifulsoup4`、`lxml`、`pillow`、`paramiko`、`cryptography`）。sandbox 代码会优先使用 `SANDBOX_PYTHON_BIN` 或 `SANDBOX_PYTHON_ROOT` 指定的 Python；容器中默认自动落到系统 Python。

Docker 默认权限通常不允许 bubblewrap 创建命名空间。Samata 会真实试跑 bubblewrap，只有可用时才启用文件系统隔离；不可用时自动退回普通执行，保证 Python/Node sandbox 任务能跑。若生产环境必须强隔离，需要单独评估并显式提高容器权限（例如 privileged 级别），不建议作为默认 compose 配置。

生产环境默认不提供 Chromium/Chrome DevTools 浏览器工具。`NODE_ENV=production` 时 Samata 会跳过 `devtools` MCP，不注册 `mcp_devtools_*`，并从 Agent prompt 中移除浏览器工具说明，避免在生产网络不可达时反复调用浏览器。特殊环境确实需要启用时可显式设置 `SAMATA_ENABLE_CHROMIUM_TOOLS=1`；开发环境需要禁用时可设置 `SAMATA_DISABLE_CHROMIUM_TOOLS=1`。

Wind、Fast Trading、Log 相关数据由本机已有的 `wind_sync_pg` Postgres 容器提供，该容器由外部 crontab 每日更新。Samata compose 会加入外部 Docker 网络 `samata-wind-sync`，并把 `PG_WIND_HOST`、`FAST_TRADING_PG_HOST`、`WIND_PG_HOST`、`LOG_PG_HOST` 指向 `wind_sync_pg`，避免再维护一份不同步的 compose 内部空库。

首次部署前需要准备共享网络，并把 `wind_sync_pg` 接入该网络：

```bash
docker network create samata-wind-sync || true
docker network connect --alias wind_sync_pg samata-wind-sync wind_sync_pg || true
```

`.env` 通过只读挂载提供给容器内应用，由 Samata 启动时的 dotenv 加载，不会进入镜像。不要把 `.env` 配成 compose `env_file`，密钥中如果包含 `$` 可能会被 Compose 当变量插值处理。`environment` 中显式配置的容器内地址会覆盖 `.env` 里的本地开发地址。

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
