---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Docker 镜像版本化 Tag 与清理

## 背景

本机 Docker 构建 Samata 后留下多张 `<none>:<none>` dangling 镜像，占用数 GB 空间；同时 `docker-compose.yml` 固定使用 `samata:latest`，缺少可追溯版本 tag。

本次已执行 `docker image prune -f` 清理 dangling 镜像，不删除正在运行的 `samata:latest`。

## 决策

1. 保留 `samata:latest` 作为兼容别名。
2. 默认构建主 tag 改为包含 `package.json` 版本与 git short sha：`samata:<version>-<git-sha>`。
3. 构建完成后同步打上 `samata:<version>` 和 `samata:latest`。
4. 如果工作区有未提交改动，主 tag 自动追加 `dirty-YYYYMMDDHHMMSS`，避免重复覆盖同一个 tag 后继续产生 dangling 镜像。
5. Docker Compose 继续支持裸命令默认回退 `latest`，但推荐通过脚本启动。

## 改动清单

- `Dockerfile`
  - 增加 `SAMATA_VERSION`、`SAMATA_COMMIT` build args。
  - 写入 OCI image labels：title、version、revision。
- `docker-compose.yml`
  - 抽出 Samata build 配置 anchor。
  - 支持 `SAMATA_IMAGE_REPO`、`SAMATA_IMAGE_TAG`、`SAMATA_VERSION`、`SAMATA_COMMIT` 环境变量。
- `scripts/docker-samata.sh`
  - 新增版本化构建/启动脚本，支持 `up`、`build`、`prune`。
  - 自动读取 `package.json` version 与 git short sha。
  - 构建后补 `samata:<version>` 和 `samata:latest` 别名。
- `package.json`
  - 新增 `docker:samata:up`、`docker:samata:build`、`docker:samata:prune`。
- `docs/platform/deployment.md`
  - 更新 Docker 部署命令和镜像 tag 说明。

## 验证命令

```bash
docker image prune -f
bash -n scripts/docker-samata.sh
docker compose --env-file /dev/null config --quiet
npm run docs:plan-sync
```

结果：

- dangling 镜像已清理；`docker images` 中不再显示 `samata` 相关 `<none>:<none>` 镜像。
- `bash -n scripts/docker-samata.sh`：通过。
- `docker compose --env-file /dev/null config --quiet`：通过。
- `npm run docs:plan-sync`：退出码 0，新留档进入索引；输出中仍有若干历史 plan 缺 `docModules` 的既有提示，本次未改动。

## Commit Hash

待提交后在最终回复中记录。
