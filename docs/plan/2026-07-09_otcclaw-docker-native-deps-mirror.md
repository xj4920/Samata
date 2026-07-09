---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# OtcClaw Docker 原生依赖下载源加固

## 背景

刷新 `docker-baseline/samata.db` 后需要重新构建 OtcClaw 镜像，才能把新的 SQLite baseline 带入 `/app/samata/docker-baseline/samata.db`。构建在 `/app/work-plugins` 执行 `npm ci --include=dev` 时失败，失败依赖为 `better-sqlite3`：

- `prebuild-install` 下载预编译二进制包超时。
- 回退到 `node-gyp rebuild --release` 后，又从 `nodejs.org` 下载 Node headers 时遇到 `ECONNRESET`。

Dockerfile 的依赖安装层只复制 `package.json` / `package-lock.json`，没有在 `npm ci` 前复制项目 `.npmrc`，因此构建层没有稳定继承本地 better-sqlite3 镜像配置。

## 决策

在 Dockerfile 全局 `ENV` 中固化构建期 npm 下载配置，使主仓、公共插件和工作区插件的三个 `npm ci` 阶段共享同一套下载源与重试策略：

- npm registry 使用 `https://registry.npmmirror.com/`。
- node-gyp headers 使用 `https://npmmirror.com/mirrors/node`。
- better-sqlite3 预编译包使用 `https://registry.npmmirror.com/-/binary/better-sqlite3`。
- 增加 npm fetch retry 与 timeout，降低短暂网络抖动导致的构建失败概率。

本次不改依赖版本，不修改运行库 `data/samata.db`，不写入 Samata 运行时 memory 数据。

## 改动清单

- `Dockerfile`
  - 新增 `npm_config_registry`、`npm_config_disturl`、`npm_config_better_sqlite3_binary_host_mirror`。
  - 新增 npm fetch retry/timeout 环境变量。
- `package.json`
  - patch 版本从 `3.0.28` 递增到 `3.0.29`。
- `package-lock.json`
  - 同步根包版本到 `3.0.29`。
- `docs/plan/2026-07-09_otcclaw-docker-native-deps-mirror.md`
  - 记录背景、决策、改动、验证与提交状态。

## 验证命令

```bash
npm run docker:otcclaw:build
docker run --rm --entrypoint sh otcclaw:<tag> -c 'stat -c "%n %s" /app/samata/docker-baseline/samata.db'
git diff --check
git status --short
```

## 验证结果

- `npm run docker:otcclaw:build`：通过，生成镜像 `otcclaw:v3.0.29-0709161717008`，image id 为 `sha256:ee6236d7e35bafb06b7fa21f69a9d6856388cafc762ae239e7eec6de700d8af8`。
- `/app/work-plugins` 的 `npm ci --include=dev`：通过，之前失败的 `better-sqlite3` 安装层未再因 `prebuild-install` / `node-gyp` 下载失败中断。
- 镜像内 baseline 校验：`/app/samata/docker-baseline/samata.db` 存在，大小 `31166464` bytes，SHA-256 为 `67d7fdcb930318abd5c52a80f4e681f2f2f70f468a870fd6c5c0d4928e72a885`，与本地 `docker-baseline/samata.db` 一致。
- 镜像内 `better-sqlite3` 加载校验：通过。
- `git diff --check`：通过。

## 构建与重启影响

本次改动影响 Docker image 构建行为，并且目标是让刷新后的 SQLite baseline 进入新镜像。需要重新构建 OtcClaw 镜像；如果要让部署环境使用新镜像，还需要推送并在部署机拉取、重建容器。已有 `/opt/samata/data/samata.db` 的部署环境不会被镜像内 baseline 覆盖。

## Commit

待提交。
