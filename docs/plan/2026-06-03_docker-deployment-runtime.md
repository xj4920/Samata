---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Docker 部署运行时支持

## 背景

Samata 主仓需要支持容器化启动，以便在生产环境中用 Docker Compose 同时运行主应用和 PostgreSQL，并加载同级源码插件目录。原有 CLI API 只监听 `127.0.0.1`，容器外无法访问；部署文档也缺少 Docker 运行说明。

## 决策

- 使用父目录 `..` 作为 Docker build context，让镜像可同时复制 `samata/` 和同级 `samata-plugins/`。
- 用 `Dockerfile.dockerignore` 严格限制进入构建上下文的目录，避免 `.env`、`data/`、`logs/`、`node_modules/` 打进镜像。
- 容器内默认 `CLI_API_HOST=0.0.0.0`、`CLI_API_PORT=3457`，宿主机通过 `3457:3457` 访问。
- Compose 中将常用 PostgreSQL host 覆盖为服务名 `postgres`，避免容器内误用 `127.0.0.1`。
- 插件源码复制到镜像 `/app/plugins`，并设置 `SAMATA_PLUGINS_DIR=/app/plugins`。

## 改动清单

- 新增 `Dockerfile`：
  - 基于 `node:22-bookworm-slim`。
  - 安装 Chromium、CJK/emoji 字体、pandoc、Python 和 native build 工具。
  - 分别安装主仓和 `samata-plugins` 依赖。
  - 以 `node --import tsx/esm src/index.ts --server` 启动。
  - 增加 `/health` healthcheck。
- 新增 `Dockerfile.dockerignore`：
  - 默认忽略全部内容。
  - 仅允许 `samata/`、`samata-plugins/` 进入 build context。
  - 排除 `.env*`、`data/`、`logs/`、`node_modules/` 等运行时或敏感内容。
- 更新 `docker-compose.yml`：
  - 新增 `samata` service。
  - 挂载 `.env`、`data/`、`logs/`。
  - 依赖 compose 内 PostgreSQL。
  - 设置容器内数据库 host 和插件目录环境变量。
- 更新 `src/server/cli-api.ts`：
  - 新增 `CLI_API_HOST` 环境变量。
  - server listen host 从固定 `127.0.0.1` 改为可配置。
- 更新 `docs/platform/deployment.md`：
  - 增加 Docker 部署步骤、访问方式、build context 说明、`.env` 中 `$` 转义提醒和容器内 PostgreSQL host 注意事项。

## 验证计划

- `npx tsc --noEmit`
- `docker compose config --quiet`
- `npm run docs:plan-sync`

## 后续注意

- Docker 镜像当前以源码 + `tsx/esm` 方式运行，适合快速部署；如后续要优化镜像体积，可再引入 TypeScript build 产物和 production-only 依赖层。
- 如果未来插件目录改名或拆分，需要同步更新 `Dockerfile`、`Dockerfile.dockerignore` 和 `SAMATA_PLUGINS_DIR`。
