---
docModules:
  - platform
docTopics:
  platform: Docker 生产部署目录
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Docker 生产部署目录切换到 /opt/samata

## 背景

生产部署不应把包含密钥的 `.env` 打进 Samata 镜像。镜像只承载代码、依赖和插件源码；生产配置、SQLite 数据和日志应由宿主机运行目录提供，便于权限控制、备份和配置变更。

## 决策

- 将 Samata Docker Compose 默认运行目录固定为 `/opt/samata`。
- `/opt/samata/.env` 只读挂载到容器内 `/app/samata/.env`，由应用启动时的 dotenv 加载。
- `/opt/samata/data` 与 `/opt/samata/logs` 分别挂载到容器内数据和日志目录。
- 保留 `SAMATA_DEPLOY_ROOT` 覆盖能力，方便测试或非标准部署目录。
- 不修改业务代码、不改数据库 schema、不写入 `data/samata.db` 的 memory 数据。

## 改动清单

- `docker-compose.yml`
  - 将 Samata 服务的 `.env`、`data`、`logs` bind mount 从源码目录相对路径切换为 `${SAMATA_DEPLOY_ROOT:-/opt/samata}`。
- `scripts/docker-samata.sh`
  - 新增 `SAMATA_DEPLOY_ROOT` 说明和导出。
  - `up` 前检查运行目录中 `.env` 是否存在，并确保 `data`、`logs` 目录存在。
- `docs/platform/deployment.md`
  - 更新 Docker 部署步骤，明确 `/opt/samata` 目录准备、权限和挂载关系。
- `README.md`
  - 更新 Docker 空白部署示例，指向 `/opt/samata`。

## 验证命令

```bash
bash -n scripts/docker-samata.sh
docker compose --env-file /dev/null config --quiet
docker compose --env-file /dev/null config | rg -n '/opt/samata|/app/samata/(\.env|data|logs)'
git diff --check
npm run docs:plan-sync
SAMATA_DEPLOY_ROOT=/tmp/samata-runtime-test docker compose --env-file /dev/null config | rg -n '/tmp/samata-runtime-test|/app/samata/(\.env|data|logs)'
rm -rf /tmp/samata-runtime-missing && SAMATA_DEPLOY_ROOT=/tmp/samata-runtime-missing bash scripts/docker-samata.sh up
```

结果：

- `bash -n scripts/docker-samata.sh`：通过。
- `docker compose --env-file /dev/null config --quiet`：通过。
- 默认 compose 渲染确认 `.env`、`data`、`logs` 的 source 均为 `/opt/samata`。
- `git diff --check`：通过。
- `npm run docs:plan-sync`：成功更新 `docs/.vitepress/plan-index.generated.ts`；输出仍包含既有 plan frontmatter 缺失提示，本次新增留档未报错。
- `SAMATA_DEPLOY_ROOT=/tmp/samata-runtime-test docker compose ... config`：通过，确认运行目录可覆盖。
- `SAMATA_DEPLOY_ROOT=/tmp/samata-runtime-missing bash scripts/docker-samata.sh up`：按预期在脚本层失败，并提示准备运行目录与 `.env`。

## 构建与发布

- 本次改动影响 Docker Compose 运行时挂载和部署脚本，不改变 Samata 镜像内容、npm 依赖或数据库迁移。
- 应用新 compose 配置需要先准备 `/opt/samata/.env`、`/opt/samata/data`、`/opt/samata/logs`，再重建/重启容器。当前普通用户无 `/opt` 写权限，且 `sudo -n` 需要密码，尚未完成 `/opt/samata` 准备、镜像构建或容器重启。
- 不涉及 npm 依赖变化或数据库迁移。

## Commit Hash

- 实现提交：待提交，用户确认提交后回填。
