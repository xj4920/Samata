---
docModules:
  - platform
docTopics:
  platform: LogYi MCP 部署来源
canonicalDocs:
  - /platform/common-tools
status: implemented
---

# LogYi MCP 切换到 npm latest

## 背景

Samata Docker 镜像内此前通过 `node ../samata-plugin-work/logyi-mcp/dist/server.js` 启动 LogYi MCP。该方式依赖镜像构建时复制并构建 `samata-plugin-work/logyi-mcp`，运行时不访问 npm registry。

本次需求是让 Samata 不再使用本地 `plugin-work` 下的 LogYi 构建产物，改为从公司 npm 仓库直接启动 `@gf/logyi-mcp@latest`。

## 决策

- 保持 MCP server 名为 `logyi`，避免 ticlaw 可见工具名变化。
- 使用 `npx -y --prefer-online --registry http://npm.gf.com.cn @gf/logyi-mcp@latest` 启动 LogYi MCP。
- 不在 `config/mcp-servers.json` 写入 LogYi 凭据，继续由 Samata 启动时加载 `.env`，并由 MCP manager 传递给子进程。
- 保留 `agents: ["ticlaw"]`，LogYi MCP 仍只暴露给 ticlaw。

## 改动清单

- `config/mcp-servers.json`
  - `logyi.command` 从 `node` 改为 `npx`。
  - `logyi.args` 从本地 `../samata-plugin-work/logyi-mcp/dist/server.js` 改为公司 npm `@gf/logyi-mcp@latest`。
  - 更新描述，明确来源为 npm latest。
- `Dockerfile`
  - 移除 `/app/samata-plugin-work/logyi-mcp` 的单独复制、安装依赖和构建步骤。
  - 权限修正范围移除不再存在的 `/app/samata-plugin-work`。
- `Dockerfile.dockerignore`
  - 排除 `samata-plugin-work/logyi-mcp/`，避免本地 LogYi MCP 源码进入镜像构建上下文。
- `docs/platform/deployment.md`
  - 更新 Docker 部署说明，明确 LogYi MCP 来自公司 npm `@gf/logyi-mcp@latest`。
- `docs/plan/2026-06-18_logyi-mcp-npx-latest.md`
  - 记录背景、决策、改动、验证命令、构建影响和提交状态。

## 数据流

Samata 启动后读取 `/app/samata/config/mcp-servers.json`，MCP manager 通过 stdio 启动：

```bash
npx -y --prefer-online --registry http://npm.gf.com.cn @gf/logyi-mcp@latest
```

`@gf/logyi-mcp` 进程从环境变量读取 `LOGYI_BASE_URL`、`LOGYI_USERNAME`、`LOGYI_API_KEY` 或 `LOGYI_AUTH_HEADER`，并向 Samata 暴露 LogYi 工具。由于 server 名仍为 `logyi`，ticlaw 侧工具名仍是 `mcp_logyi_logyi_search_sheets`、`mcp_logyi_logyi_submit_search` 等。

## 验证命令

已执行：

```bash
node -e "JSON.parse(require('fs').readFileSync('config/mcp-servers.json','utf8')); console.log('json ok')"
docker compose --env-file /dev/null config --quiet
docker exec samata sh -lc 'timeout 8s npm view @gf/logyi-mcp@latest version --registry http://npm.gf.com.cn'
npm run docker:samata:up
docker exec samata sh -lc 'sed -n "1,80p" /app/samata/config/mcp-servers.json'
docker logs --since 5m samata 2>&1 | rg 'MCP \[logyi\].*已连接'
```

结果：

- `config/mcp-servers.json` JSON 解析通过。
- `docker compose --env-file /dev/null config --quiet` 通过。
- 容器内 `@gf/logyi-mcp@latest` 解析为 `0.1.4`。
- `npm run docker:samata:up` 已重建并重启 Samata。
- 新镜像 tag：`samata:3.0.13-f7045064ead0-dirty-20260618171255`，并刷新 `samata:3.0.13` 与 `samata:latest`。
- 容器内 `/app/samata/config/mcp-servers.json` 已使用 `npx @gf/logyi-mcp@latest`。
- 容器内 `/app/samata-plugin-work/logyi-mcp` 和 `/app/work-plugins/logyi-mcp` 均不存在。
- `docker logs` 显示 `✅ MCP [logyi] (npx): 已连接，7 个工具`。
- `docker inspect samata` 显示容器状态为 `running healthy`。

## 构建影响

本次改动影响 Docker 镜像内的 `config/mcp-servers.json` 和 Docker 构建流程，已重建并重启 Samata 容器。不涉及数据库迁移或插件构建产物变更。

## Commit

- implementation commit hash: `a323345`
- metadata commit hash: `de7f1f89b6db29901f33b0a397868390b21ba5bb`
