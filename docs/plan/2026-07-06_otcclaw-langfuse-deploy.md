---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# OtcClaw + Langfuse 统一部署脚本

## 背景

OtcClaw 已有 `scripts/docker-samata.sh` 支持构建、启动和推送主镜像，Langfuse 也已有 `docker-compose.langfuse.yml` 独立部署文件。实际部署到 Code 制品库环境时，需要同时拉取 `dockertest.gf.com.cn/titans/otcclaw` 与 `dockertest.gf.com.cn/titans/otcclaw-langfuse-*` 镜像，避免部署机继续从公网或上游 registry 拉取 Langfuse 依赖镜像。

## 决策

1. 新增独立部署脚本 `scripts/deploy-otcclaw.sh`，面向部署机执行 `pull` / `up` / `deploy`。
2. 部署脚本强制要求 `OTCCLAW_IMAGE_TAG`，避免默认 `latest` 或未指定 tag 导致误部署。
3. `docker-compose.langfuse.yml` 保持本地开发默认上游镜像，但将每个 Langfuse 相关 image 参数化；部署脚本通过环境变量覆盖为 `otcclaw-langfuse-*`。
4. OtcClaw 主镜像仍由 `scripts/docker-samata.sh` 负责构建和发布；本次脚本只负责部署机拉取并启动，不重新打镜像。

## 改动清单

- `scripts/deploy-otcclaw.sh`
  - 新增统一部署脚本，默认拉取并启动 OtcClaw、Langfuse web/worker、ClickHouse、MinIO、Redis、Postgres。
  - 校验 `/opt/samata/.env`、`/opt/samata/mcp-servers.json`、`.env.langfuse`，支持 `SAMATA_DEPLOY_ROOT`、`LANGFUSE_ENV_FILE` 和 `OTCCLAW_WITH_WIND_SYNC`。
- `docker-compose.langfuse.yml`
  - 将 Langfuse 相关服务镜像改为可用环境变量覆盖。
  - 将 `env_file` 改为可通过 `LANGFUSE_ENV_FILE` 覆盖。
- `package.json` / `package-lock.json`
  - 版本从 `3.0.20` 递增到 `3.0.21`。
  - 新增 `docker:otcclaw:deploy` npm 脚本。
- `.env.langfuse.example`
  - 增加私有 registry 镜像变量示例。
- `README.md`、`docs/platform/deployment.md`
  - 补充统一部署命令和 `otcclaw-langfuse-*` 镜像映射。

## 验证命令

已执行：

```bash
bash -n scripts/deploy-otcclaw.sh
npm run docs:plan-sync
OTCCLAW_IMAGE_TAG=vtest docker compose --env-file .env.langfuse -f docker-compose.yml -f docker-compose.langfuse.yml config --quiet
OTCCLAW_IMAGE_REPO=dockertest.gf.com.cn/titans/otcclaw OTCCLAW_IMAGE_TAG=vtest LANGFUSE_WEB_IMAGE=dockertest.gf.com.cn/titans/otcclaw-langfuse:3 LANGFUSE_WORKER_IMAGE=dockertest.gf.com.cn/titans/otcclaw-langfuse-worker:3 LANGFUSE_CLICKHOUSE_IMAGE=dockertest.gf.com.cn/titans/otcclaw-langfuse-clickhouse-server:latest LANGFUSE_MINIO_IMAGE=dockertest.gf.com.cn/titans/otcclaw-langfuse-minio:latest LANGFUSE_REDIS_IMAGE=dockertest.gf.com.cn/titans/otcclaw-langfuse-redis:7 LANGFUSE_POSTGRES_IMAGE=dockertest.gf.com.cn/titans/otcclaw-langfuse-postgres:16 docker compose --env-file .env.langfuse -f docker-compose.yml -f docker-compose.langfuse.yml config | rg -n 'image: dockertest\.gf\.com\.cn/titans/(otcclaw|otcclaw-langfuse)'
OTCCLAW_IMAGE_TAG=vtest SAMATA_DEPLOY_ROOT=/tmp/samata-deploy-missing-check bash scripts/deploy-otcclaw.sh up
bash scripts/deploy-otcclaw.sh --help
```

结果：

- shell 语法检查通过。
- plan index 已重新生成；仓库既有旧 plan 仍会打印 frontmatter 警告/错误，本次新增 plan 已补齐 `docModules`。
- Compose 配置校验通过。
- 镜像渲染确认使用 `dockertest.gf.com.cn/titans/otcclaw` 与 `dockertest.gf.com.cn/titans/otcclaw-langfuse-*`。
- 缺少运行目录 `.env` 时按预期退出，未启动容器。

## Commit

- implementation commit hash：`65c19cc`

## 构建与重启影响

本次改动影响部署脚本、Compose 配置和文档，不改变 Samata 运行时代码、依赖安装内容或数据库迁移。由于 `package.json` 版本递增，后续发布 OtcClaw 镜像时需要重新执行 baseline refresh、build/push；当前运行容器无需因本次脚本改动立即重启。
