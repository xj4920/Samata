---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Dockerfile 缓存层顺序优化

## 背景

Samata Docker 镜像加入版本化 tag 后，`SAMATA_VERSION`、`SAMATA_COMMIT` build args 和 OCI labels 位于 Dockerfile 顶部。每次 commit/tag 变化都会让后续 `apt-get install` 与多个 `npm ci` 层失效，导致构建时间偏长。

另外，构建上下文来自 Samata 主仓的上级目录，需要同时包含 `samata`、`samata-plugins`、`samata-plugin-work`。需要确保本机 `.git`、`node_modules`、运行数据和日志不会进入 build context。

## 决策

1. 将版本 build args 与 OCI labels 移到 Dockerfile 末尾，只影响最终镜像元数据。
2. 将主仓和插件仓的依赖安装拆成 manifest 层：
   - 先复制根 `package.json`、`package-lock.json`。
   - 再复制 workspace `package.json`。
   - 执行 `npm ci --include=dev`。
   - 最后复制完整源码。
3. 保留普通插件仓内既有 `dist` 产物，不在 ignore 规则中排除，因为当前镜像构建没有为这些插件统一执行 build。
4. 使用 `Dockerfile.dockerignore` 泛化排除 `.git`、`node_modules`、本地 env、运行数据和日志，保持 build context 小而稳定。

## 改动清单

- `Dockerfile`
  - 移除顶部 `ARG SAMATA_VERSION`、`ARG SAMATA_COMMIT` 和 `LABEL`。
  - 将 OCI labels 放到 `HEALTHCHECK` 之后、`CMD` 之前。
  - 主仓依赖层只复制 `samata/package*.json` 与 `packages/plugin-sdk/package.json` 后执行 `npm ci`。
  - `samata-plugins` 与 `samata-plugin-work` 先复制 workspace manifest 并安装依赖，再复制源码。
  - `logyi-mcp` 继续独立安装依赖并执行 build。
- `Dockerfile.dockerignore`
  - 泛化排除 `**/.git` 与 `**/node_modules`。
  - 保留 `samata/.env.example`、`samata/.env.langfuse.example` 作为示例文件。
  - 继续排除 `samata/data` 与 `samata/logs`。

## 验证命令

```bash
docker compose --env-file /dev/null config --quiet
git diff --check
SAMATA_IMAGE_TAG=cache-order-test SAMATA_VERSION=$(node -p "require('./package.json').version") SAMATA_COMMIT=$(git rev-parse --short=12 HEAD) docker compose --env-file /dev/null build samata
time SAMATA_IMAGE_TAG=cache-order-test SAMATA_VERSION=$(node -p "require('./package.json').version") SAMATA_COMMIT=$(git rev-parse --short=12 HEAD) docker compose --env-file /dev/null build samata
docker image inspect samata:cache-order-test --format '{{ index .Config.Labels "org.opencontainers.image.version" }} {{ index .Config.Labels "org.opencontainers.image.revision" }}'
docker rmi samata:cache-order-test
docker image prune -f
```

结果：

- `docker compose --env-file /dev/null config --quiet`：通过。
- `git diff --check`：通过。
- 首次验证构建通过；build context 约 `1.48MB`，`apt-get install` 已命中缓存，重建了新的 npm manifest 依赖层。
- 第二次相同构建全部关键步骤命中缓存，用时约 `2.8s`。
- 临时验证镜像 label 输出：`3.0.13 fa25f6621663`。
- 临时 `samata:cache-order-test` tag 已删除。

## Commit Hash

实现提交：待提交。
