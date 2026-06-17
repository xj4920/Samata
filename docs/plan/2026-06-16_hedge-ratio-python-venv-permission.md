---
docModules:
  - platform
docTopics:
  platform: Docker 插件运行时权限
status: superseded
canonicalDocs:
  - /platform/deployment
---

# Hedge Ratio Python Venv 权限修复

> 2026-06-17 复核说明：本文件记录上一轮未提交的排障与验证草稿；当前运行镜像 `samata:latest`
> 仍未包含 entrypoint 权限修复，因此本文件中的“已重建并重启”不再作为当前运行态依据。
> 本次实际执行与验证见 `2026-06-17_hedge-ratio-venv-runtime-permission.md`。

## 背景

`hedge-ratio-email-sync` 在 Docker 容器中持续失败：

```text
Python environment bootstrap failed: EACCES: permission denied, rmdir '/app/work-plugins/hedge-ratio/.venv'
```

排查发现镜像构建上下文带入了宿主机 `samata-plugin-work/hedge-ratio/.venv`。该 venv 由宿主机 Python 3.10.4 创建，容器内 `.venv/bin/python3.10` 指向不存在的 `/usr/local/python-3.10.4/bin/python3.10`。插件检测到 venv Python 不可用后会删除旧 `.venv` 并重建，但容器主进程以 `node` 用户运行，而 `/app/work-plugins/hedge-ratio` 父目录归 `root:root`，导致 `node` 无法删除 `.venv`。

同时，插件邮件附件和解析结果会写入 `attachments/` 与 `data/`，这两个目录在镜像内也需要对 `node` 可写。

重建验证时还发现宿主机部分源码文件权限为 `600`，Docker `COPY` 会把该模式带入镜像，导致 `node` 用户读取 `/app/samata/package.json` 报 `EACCES` 并造成容器启动循环。因此本次修复同时收敛镜像内源码读权限。

## 决策

- Docker 构建上下文排除 Python venv、`__pycache__`、pytest cache，以及 `hedge-ratio` 的运行时 `attachments/` 和 `data` 非静态输出。
- `hedge-ratio/data/1800` 包含套保计算必需的成分股静态 Excel，需要保留在镜像内。
- 镜像构建阶段清理可能残留的 `hedge-ratio` 运行时目录，并创建空的 `attachments/`、`data/`。
- 镜像构建阶段将 `hedge-ratio` 插件目录本身和运行时目录设置为 `node` 可写，允许容器内创建 `.venv`。
- entrypoint 启动阶段保留权限兜底，避免旧镜像层、挂载或后续构建变化再次造成 `node` 无法写入运行时目录。
- 镜像构建末尾统一将应用与插件源码设为运行用户可读、目录可进入，避免宿主机 `600` 文件模式进入镜像后影响 `node` 读取。

## 改动清单

- `Dockerfile.dockerignore`
  - 新增 `.venv`、`__pycache__`、`.pytest_cache` 排除规则。
  - 新增 `samata-plugin-work/hedge-ratio/attachments` 与 `data` 运行时输出排除规则。
  - 保留 `samata-plugin-work/hedge-ratio/data/1800` 静态成分股文件。
- `Dockerfile`
  - 复制工作区插件后清理 `hedge-ratio` 的 `.venv`、`attachments`。
  - 创建空运行时目录，并设置 `hedge-ratio` 目录与运行时目录权限。
  - 复制 Samata 源码后统一设置 `/app/samata`、`/app/plugins`、`/app/work-plugins`、`/app/samata-plugin-work` 的读取/进入权限。
- `scripts/docker-entrypoint.sh`
  - 启动时创建 `hedge-ratio` 运行时目录。
  - 启动时确保插件目录、`.venv`、`attachments`、`data` 对 `node` 用户可写。

## 验证命令

已执行：

```text
bash -n scripts/docker-entrypoint.sh
docker compose config
git diff --check
npm run docs:plan-sync
docker compose up -d --build samata
docker exec -u node samata sh -lc 'test -w /app/work-plugins/hedge-ratio && test -w /app/work-plugins/hedge-ratio/attachments && test -w /app/work-plugins/hedge-ratio/data'
docker exec -u node samata sh -lc 'test -x /app/work-plugins/hedge-ratio/.venv/bin/python && /app/work-plugins/hedge-ratio/.venv/bin/python --version'
docker exec samata sh -lc 'find /app/work-plugins/hedge-ratio/data/1800 -maxdepth 1 -type f -printf "%f\n" | sort'
docker logs --since 10m samata | rg "Python environment bootstrap failed|EACCES: permission denied, rmdir|no component stock files could be loaded"
docker logs --since 10m samata | rg "hedge-ratio-email-sync\] synced emails|hedge-ratio:python-bootstrap\] environment ready|loaded .* component stocks"
docker inspect samata --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}'
```

## 验证结果

- `bash -n scripts/docker-entrypoint.sh` 通过。
- `docker compose config` 通过；仍有既有 `.env` 变量展开 warning：`iwh4LJ92BzH` 未设置。
- `git diff --check` 通过。
- `npm run docs:plan-sync` 通过并更新 `docs/.vitepress/plan-index.generated.ts`；输出仍包含既有历史 plan frontmatter warning/error，本次新增 plan 未被点名。
- `docker compose up -d --build samata` 已重建并重启 `samata`，新镜像为 `sha256:d1fce030c679c38299f1c968a2484a4b29f140c80f10c274653b5d48fe715a5a`。
- 容器内 `node` 用户可读 `/app/samata/package.json`，可写 `/app/work-plugins/hedge-ratio`、`attachments`、`data`。
- 容器内 `.venv/bin/python` 指向 `/usr/bin/python3.11`，不再指向宿主机 `/usr/local/python-3.10.4/bin/python3.10`。
- `data/1800` 三个成分股静态 Excel 已保留在镜像内。
- 最近 10 分钟日志无 `Python environment bootstrap failed`、`.venv rmdir EACCES`、`no component stock files could be loaded`。
- 日志显示 `[hedge-ratio:python-bootstrap] environment ready`，并显示 `[hedge-ratio-email-sync] synced emails=6, duplicates=1`。
- 日志显示三份成分股文件分别加载成功：中证1000 1001 条、沪深300 301 条、中证500 501 条。
- `samata` 容器状态为 `running healthy`。
- 仍观察到 SFTP `Authentication (password) failed` 日志，这是后续上传凭据/配置问题，不属于本次 Python venv 与目录权限故障。

## Commit Hash

- 实现提交：待提交后回填。
- 留档回填提交：待提交后回填。

## 构建与运行影响

- 影响 Docker image，需要重新构建 `samata` 镜像。
- 已重新构建 `samata:latest` 并重启 `samata` 容器。
- 不涉及数据库迁移或依赖版本变更。
