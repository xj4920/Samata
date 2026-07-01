---
docModules:
  - platform
docTopics:
  platform: LogYi MCP 配置挂载
canonicalDocs:
  - /platform/deployment
status: implemented
---

# LogYi MCP 配置改为部署挂载

## 背景

2026-07-01 排查 `ticlaw` 调用 LogYi MCP 返回“工具不在当前用户的允许列表中”时确认，数据库中 `ticlaw` 与许骏企微身份均具备 agent 权限；真正原因是当前运行容器缺少 `/app/samata/config/mcp-servers.json`，启动时没有注册 `logyi` MCP server。

历史镜像中曾因本机构建上下文包含 ignored 的 `config/mcp-servers.json` 而可用，但该文件未纳入 Git，也未由 Compose 挂载，导致 2026-06-30 某次重建后运行镜像不含该文件，LogYi MCP 工具消失。

## 决策

- 将真实 MCP server 配置视为部署运行时配置，放在 `${SAMATA_DEPLOY_ROOT:-/opt/samata}/mcp-servers.json`。
- 通过 Docker Compose 只读挂载到容器内 `/app/samata/config/mcp-servers.json`，避免依赖构建机本地 ignored 文件。
- 仓库只提交 `config/mcp-servers.example.json` 示例，真实凭据继续只放 `/opt/samata/.env`。
- `scripts/docker-samata.sh up` 在启动前检查本地 MCP 配置是否存在，缺失时直接提示准备步骤。

## 改动清单

- `docker-compose.yml`
  - 新增 `${SAMATA_DEPLOY_ROOT:-/opt/samata}/mcp-servers.json` 到 `/app/samata/config/mcp-servers.json` 的只读 bind mount。
- `scripts/docker-samata.sh`
  - 启动前检查 `$deploy_root/mcp-servers.json`，缺失时提示从 example 复制并保留真实凭据在 `.env`。
- `config/mcp-servers.example.json`
  - 新增 DevTools、`ticlaw` LogYi、`OtcmsClaw` LogYi MCP 示例配置。
- `docs/platform/deployment.md`
  - 更新 Docker 部署说明，明确 MCP 配置从 `/opt/samata/mcp-servers.json` 挂载。
- `package.json` / `package-lock.json`
  - patch 版本递增。

## 验证命令

```bash
npm test -- --run tests/unit/services/mcp-manager-logyi-guard.test.ts
docker compose --env-file /dev/null config
bash -n scripts/docker-samata.sh
node -e "JSON.parse(require('fs').readFileSync('config/mcp-servers.example.json','utf8')); console.log('ok')"
```

部署后验证：

```bash
docker exec samata test -f /app/samata/config/mcp-servers.json
docker logs --since 5m samata 2>&1 | rg 'MCP \[logyi\].*已连接'
```

## 构建与重启影响

- 本次改动不改变应用运行时代码逻辑，也不需要数据库迁移。
- Docker image 内容不必须重建才能获得 MCP 配置；关键是准备 `/opt/samata/mcp-servers.json` 并用更新后的 Compose 重新创建/重启 `samata` 容器。
- 若按版本发布新镜像，仍需正常构建并推送镜像；运行态修复需要 `docker compose up -d` 使新增挂载生效。

## Commit Hash

- implementation commit hash: `d2ef83a`
- metadata commit hash: docs-only 回填提交见最终回复。
