---
docModules:
  - platform
docTopics:
  platform: Docker Agent prompt 权限
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Docker Agent Prompt 运行时写权限修复

## 背景

在 Docker CLI 中为新 Agent 创建 system prompt 时，写入 `/app/samata/config/agents/OtcmsClaw.md` 失败：

```text
EACCES: permission denied, open '/app/samata/config/agents/OtcmsClaw.md'
```

容器内应用进程以 `node` 用户运行，但镜像中的 `/app/samata/config/agents` 来源于源码复制，默认归属 `root`。因此即使当前用户是系统管理员，`write_file` 和 shell 重定向最终都会被 Linux 文件权限拒绝。

## 决策

- 在镜像构建阶段将 `/app/samata/config/agents` 递归授权给 `node:node`。
- 在 `docker-entrypoint.sh` 启动阶段再次确保目录存在并执行 `chown`，兼容旧镜像层、挂载目录或部署目录权限漂移。
- 不把长期规则写入 `data/samata.db` 的 memory 表；Agent prompt 继续以 `config/agents/<name>.md` 作为 git 管理的唯一来源。
- 默认 compose 不新增 `config/agents` 持久化挂载；生产 prompt 应提交到仓库后重建镜像。容器内临时创建仅用于应急或交互生成草稿。
- Agent name 和 prompt 文件名按 `agent.name` 精确匹配；交互式 `/agent create` 要求小写英文名称。显示名可以使用 `OtcmsClaw`，但 name/文件建议使用小写 `otcmsclaw`。

## 受影响模块与数据流

- `Dockerfile`
  - 构建时创建 `config/agents`，并将 `config/agents`、`data`、`logs` 一并授权给 `node:node`。
- `scripts/docker-entrypoint.sh`
  - 启动时对 `/app/samata/config/agents`、`/app/samata/data`、`/app/samata/logs` 做权限兜底，然后再 `gosu node` 启动应用。
- `docs/platform/deployment.md`
  - 说明 CLI 可写权限、重建容器后的持久化边界，以及 Agent name 与 prompt 文件名的匹配规则。

运行数据流：

```text
CLI write_file / exec_cmd
  -> /app/samata/config/agents/<agent.name>.md
  -> src/llm/agents/prompt.ts loadPromptTemplate()
  -> buildSystemPrompt()
```

## 改动清单

- `Dockerfile`
  - 将 `config/agents` 加入运行时可写目录授权。
- `scripts/docker-entrypoint.sh`
  - 启动期确保 `/app/samata/config/agents` 存在并归属 `node:node`。
- `docs/platform/deployment.md`
  - 增加 Agent prompt 权限与持久化说明。
- `docs/plan/2026-06-25_agent-prompt-runtime-permission.md`
  - 记录本次问题背景、设计决策、改动和验证。

## 验证命令

已执行：

```bash
git pull --ff-only
bash -n scripts/docker-entrypoint.sh
docker compose --env-file /dev/null config --quiet
npm run docker:samata:build
npm run docs:plan-sync
npm run docs:plan-sync -- --check
git diff --check
```

结果：

- `git pull --ff-only`：已经是最新的。
- `bash -n scripts/docker-entrypoint.sh`：通过。
- `docker compose --env-file /dev/null config --quiet`：通过。
- `npm run docs:plan-sync`：退出码 0，已更新 `docs/.vitepress/plan-index.generated.ts`；仍输出既有历史 plan frontmatter warning/error，本次新增 plan 已进入索引。
- `npm run docs:plan-sync -- --check`：索引已是最新；因既有历史 plan 缺少 `docModules` 返回退出码 1，本次新增 plan 不在错误列表。
- `git diff --check`：通过，无空白错误。

构建验证：

```bash
npm run docker:samata:build
docker image inspect node:22-bookworm-slim
npm run docker:samata:build
```

结果：两次 `npm run docker:samata:build` 均在加载 Docker Hub `node:22-bookworm-slim` 元数据阶段失败，错误为 `failed to do request ... EOF`；本地也没有 `node:22-bookworm-slim` 缓存。因此尚未执行镜像内 `node` 用户写入 `/app/samata/config/agents/.permission-test` 的运行验证。

## 构建与重启判断

本次改动影响 Docker 镜像内文件权限和 entrypoint 启动逻辑，不涉及 npm 依赖、数据库迁移或插件构建产物。部署生效需要重新构建 Samata image 并重启容器；只更新运行中容器内文件权限不能覆盖下一次镜像重建。

## Commit Hash

- 实现提交：待提交。
