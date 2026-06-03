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
```

从 `samata/` 目录启动：

```bash
cp .env.example .env
# 编辑 .env，配置 LLM Provider、Bot 凭证和外部服务密钥
docker compose up -d --build
docker compose logs -f samata
```

如果 `.env` 中的密码包含 `$`，需要在 `.env` 中写成 `$$`，或使用单引号包住完整值，避免 Docker Compose 把它当作变量插值。

容器内 Samata 监听 `0.0.0.0:3457`，宿主机可访问：

```bash
curl http://127.0.0.1:3457/health
CLI_SERVER_URL=http://127.0.0.1:3457 npm run cli
```

`docker-compose.yml` 使用父目录 `..` 作为 build context，并通过 `Dockerfile.dockerignore` 只允许 `samata/` 和 `samata-plugins/` 进入构建上下文。`.env`、`data/`、`logs/` 和 `node_modules/` 不会打进镜像；运行时会只读挂载 `./.env`，并挂载 `./data` 和 `./logs`。插件源码会复制到镜像内的 `/app/plugins`，并通过 `SAMATA_PLUGINS_DIR=/app/plugins` 加载。

容器内访问 compose 自带的 Postgres 时必须使用服务名 `postgres`，不能使用 `127.0.0.1`。compose 已覆盖常用变量：`PG_WIND_HOST`、`FAST_TRADING_PG_HOST`、`WIND_PG_HOST` 和 `LOG_PG_HOST`。

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

## Agent 示例

Moss 这类轻量 Agent 的部署流程包括：创建 prompt、创建 Agent、配置成员、绑定 Bot 渠道。原始实施记录见 [Moss Agent 部署演进记录](../plan/2026-05-25_moss-deployment-guide.md)。
