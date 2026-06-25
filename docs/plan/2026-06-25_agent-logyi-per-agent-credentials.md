---
docModules:
  - platform
docTopics:
  platform: Agent 维度 LogYi 凭据
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Agent 维度 LogYi MCP 凭据

## 背景

`ticlaw` 和 `OtcmsClaw` 都需要使用 LogYi MCP 查询生产日志，但两者使用不同的 LogYi 登录凭据。原配置只有一个 `logyi` MCP server，且 `agents` 白名单只包含 `ticlaw`；即使 `OtcmsClaw` 的工具配置与 `ticlaw` 接近，也无法看到或调用 LogYi 工具。

## 决策

- 将 LogYi 凭据放在 `/opt/samata/.env`，不写入 git 仓库。
- 使用两个 MCP server 实例：
  - `logyi` 绑定 `ticlaw`，读取 `TICLAW_LOGYI_*`。
  - `logyiotcmsclaw` 绑定 `OtcmsClaw`，读取 `OTCMSCLAW_LOGYI_*`。
- 在 MCP server 配置中新增逻辑类型 `kind: "logyi"`，让多个 LogYi 实例共享工具描述和调用前时间范围护栏。
- 保留 `logyi` server name，避免 `ticlaw` 现有工具名前缀从 `mcp_logyi_*` 改变。
- `OtcmsClaw` 使用新的工具名前缀 `mcp_logyiotcmsclaw_*`。

## 改动清单

- `config/mcp-servers.json`
  - `logyi` 增加 `kind: "logyi"`，改为读取 `TICLAW_LOGYI_*` 运行时变量。
  - 新增 `logyiotcmsclaw`，读取 `OTCMSCLAW_LOGYI_*` 运行时变量，并只暴露给 `OtcmsClaw`。
  - 该文件属于 `.gitignore` 下的本地运行配置，本次已在宿主与当前容器内更新，但不进入 git 提交。
- `src/services/mcp-manager.ts`
  - MCP server 配置类型增加 `kind`。
  - LogYi 工具描述和调用前时间范围护栏从 `serverName === "logyi"` 改为识别 `kind === "logyi"`。
- `tests/unit/services/mcp-manager-logyi-guard.test.ts`
  - 增加 per-agent LogYi server 仍会注入时间范围说明的覆盖。
- `docs/platform/deployment.md`
  - 增加多 Agent LogYi 凭据配置说明。
- `/opt/samata/.env`
  - 已新增 `TICLAW_LOGYI_*` 与 `OTCMSCLAW_LOGYI_*` 运行时变量；明文 key 不进入仓库。

## 验证命令

已执行：

```bash
git pull --ff-only
npm run test:unit -- tests/unit/services/mcp-manager-logyi-guard.test.ts
docker compose --env-file /dev/null config --quiet
npm run docs:plan-sync
npm run docs:plan-sync -- --check
git diff --check
docker cp config/mcp-servers.json samata:/app/samata/config/mcp-servers.json
docker cp src/services/mcp-manager.ts samata:/app/samata/src/services/mcp-manager.ts
docker restart samata
docker logs --since 2m samata 2>&1 | rg 'MCP \\[(logyi|logyiotcmsclaw)\\]'
curl -fsS http://127.0.0.1:3457/health
curl -fsS -X POST http://127.0.0.1:3457/api/cli/session ...
curl -fsS -X POST http://127.0.0.1:3457/api/cli/execute ... '/agent info'
```

结果：

- `git pull --ff-only`：已经是最新的。
- `/opt/samata/.env`：已备份为 `/opt/samata/.env.backup-20260625161831`，并确认 `TICLAW_LOGYI_BASE_URL`、`TICLAW_LOGYI_USERNAME`、`TICLAW_LOGYI_API_KEY`、`OTCMSCLAW_LOGYI_BASE_URL`、`OTCMSCLAW_LOGYI_USERNAME`、`OTCMSCLAW_LOGYI_API_KEY` 均存在；未在终端输出完整 key。
- `npm run test:unit -- tests/unit/services/mcp-manager-logyi-guard.test.ts`：1 个测试文件通过，8 个用例通过。
- `docker compose --env-file /dev/null config --quiet`：通过。
- `npm run docs:plan-sync`：退出码 0，已更新 `docs/.vitepress/plan-index.generated.ts`；仍输出既有历史 plan frontmatter warning/error，本次新增 plan 已进入索引。
- `npm run docs:plan-sync -- --check`：索引已是最新；因既有历史 plan 缺少 `docModules` 返回退出码 1，本次新增 plan 不在错误列表。
- `git diff --check`：通过，无空白错误。
- 当前运行容器已同步 `config/mcp-servers.json` 与 `src/services/mcp-manager.ts`，随后执行 `docker restart samata`。
- `docker ps --filter name=samata`：`samata` 状态为 `Up ... (healthy)`。
- `curl -fsS http://127.0.0.1:3457/health`：返回 `{"ok":true}`。
- `docker logs --since 90s samata 2>&1 | rg 'MCP \[(logyi|logyiotcmsclaw)'`：确认 `✅ MCP [logyi] (npx): 已连接，7 个工具` 与 `✅ MCP [logyiotcmsclaw] (npx): 已连接，7 个工具`。
- CLI API 创建 `OtcmsClaw` 会话并执行 `/agent info`：可用工具列表包含 `mcp_logyiotcmsclaw_logyi_search_sheets`、`mcp_logyiotcmsclaw_logyi_submit_search`、`mcp_logyiotcmsclaw_logyi_fetch_search` 等 7 个 LogYi 工具。
- CLI API 创建 `ticlaw` 会话并执行 `/agent info`：可用工具列表保留 `mcp_logyi_logyi_search_sheets`、`mcp_logyi_logyi_submit_search`、`mcp_logyi_logyi_fetch_search` 等 7 个原 LogYi 工具。

## 构建与重启判断

本次改动影响运行时代码、MCP 配置和运行时 `.env`。若部署使用当前工作区源码或热运行容器，重启 `samata` 容器后生效；若使用镜像内打包代码部署，需要重新构建 Samata image 并重启容器。不涉及数据库迁移、npm 依赖变化或插件构建产物。

## Commit Hash

- 实现提交：`81e80dab732c27a5c6aa9abb17726bc15fb5961c`。
