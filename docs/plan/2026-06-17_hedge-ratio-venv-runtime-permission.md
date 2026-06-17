---
docModules:
  - platform
docTopics:
  platform: Docker 插件运行时权限
status: implemented
canonicalDocs:
  - /platform/deployment
---

# Hedge Ratio Venv Runtime Permission Follow-up

## 背景

2026-06-17 检查运行中的 `samata` 容器时，`hedge-ratio-email-sync` 仍反复失败：

```text
Python environment bootstrap failed: python3 -m venv .venv exited with code 1
stderr: Error: [Errno 13] Permission denied: '/app/work-plugins/hedge-ratio/.venv'
```

进一步检查确认：

- 当前 `samata:latest` 镜像内的 `scripts/docker-entrypoint.sh` 仍是旧版本，只处理 `/app/samata/data` 和 `/app/samata/logs`。
- 当前容器内 `/app/work-plugins/hedge-ratio` 为 `root:root 775`，运行进程为 `node` 用户，`node` 无法创建 `.venv`。
- 直接 SFTP 探测已验证当前 `HEDGE_RATIO_SFTP_*` 凭据可以登录远端目录；本次问题发生在 Python venv 初始化阶段，尚未进入 SFTP 上传。

## 决策

- 保留 Dockerfile 中对 `hedge-ratio` 运行时目录的构建期清理与创建。
- 保留 entrypoint 的启动期权限兜底：容器以 root 进入 entrypoint，创建/chown `hedge-ratio` 可写目录后再 `gosu node` 启动服务。
- 本次修复影响 Docker image 和运行中容器，必须重新构建镜像并重建/重启 `samata` 容器。
- 构建前记录 `samata-plugin-work` 当前存在未提交改动；Docker build 会复制该工作区现状进镜像。

## 改动清单

- `Dockerfile`
  - 排除旧 `hedge-ratio/.venv` 与运行时附件目录。
  - 创建 `hedge-ratio/attachments`、`hedge-ratio/data`。
  - 设置 `hedge-ratio` 目录和运行时目录对 `node` 可写。
  - 统一修正镜像内源码目录可读/可进入权限。
- `Dockerfile.dockerignore`
  - 排除 `.venv`、`__pycache__`、`.pytest_cache`。
  - 排除 `hedge-ratio` 运行时输出目录，同时保留 `data/1800` 静态成分股文件。
- `scripts/docker-entrypoint.sh`
  - 启动时创建并 chown `hedge-ratio` 运行时目录。

## 验证命令

已执行：

```text
bash -n scripts/docker-entrypoint.sh
docker compose config
git diff --check
npm run docs:plan-sync
docker compose up -d --build samata
docker run --rm --entrypoint sh samata:latest -lc 'sed -n "1,80p" /app/samata/scripts/docker-entrypoint.sh'
docker exec -u node samata sh -lc 'test -w /app/work-plugins/hedge-ratio && test -w /app/work-plugins/hedge-ratio/attachments && test -w /app/work-plugins/hedge-ratio/data'
docker logs --since 10m samata 2>&1 | rg "Python environment bootstrap failed|Permission denied: '/app/work-plugins/hedge-ratio/.venv'"
docker inspect samata --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}'
```

## 验证结果

- `bash -n scripts/docker-entrypoint.sh` 通过。
- `docker compose config` 通过。
- `git diff --check` 通过。
- `npm run docs:plan-sync` 成功更新 `docs/.vitepress/plan-index.generated.ts`；仍有既有历史 plan frontmatter warning/error。
- `docker compose up -d --build samata` 已重新构建并重建启动 `samata` 容器。
- 新镜像为 `sha256:64bf4bf12fb8aaafab5ad67c7a892c4bf0c722afe37af38669e4bc845981c888`，label revision 为 `75fabde-dirty-20260617105118`。
- 临时容器检查确认镜像内 `scripts/docker-entrypoint.sh` 已包含 `hedge-ratio` runtime chown。
- 运行中容器检查确认：
  - PID 1 为 `node` 用户。
  - `/app/work-plugins/hedge-ratio`、`.venv`、`attachments`、`data` 均为 `node:node 755`。
  - `node` 用户可写 `hedge-ratio`、`attachments`、`data`。
  - `.venv/bin/python` 可执行，版本为 `Python 3.11.2`，路径为 `/app/work-plugins/hedge-ratio/.venv/bin/python`。
  - `data/1800` 三个静态成分股 Excel 文件保留。
- 最近启动日志显示：
  - `[hedge-ratio:python-bootstrap] creating venv with python3`
  - `[hedge-ratio:python-bootstrap] installing requirements.txt`
  - `[hedge-ratio:python-bootstrap] environment ready`
  - `IMAP login succeeded for titans@gf.com.cn`
  - `[hedge-ratio-email-sync] synced emails=0, duplicates=0`
- 最近启动日志未再出现 `Python environment bootstrap failed` 或 `Permission denied: '/app/work-plugins/hedge-ratio/.venv'`。
- `samata` 容器状态为 `running healthy`。

## Commit Hash

- 实现提交：待提交后回填。
- 留档回填提交：待提交后回填。

## 构建与运行影响

- 影响 Docker image：需要重新构建 `samata:latest`。
- 影响运行中容器：需要重建/重启 `samata` 容器。
- 不涉及数据库迁移。
