---
docModules:
  - platform
  - plugins
docTopics:
  platform: 部署与运行
  plugins: 插件接入
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Samata 本地运行时改动推送 GitHub

## 背景

本地 `samata` 仓库已有一批未提交改动，需要整理后推送到 GitHub remote `git@github.com:xj4920/Samata.git`。改动主要围绕生产 Docker 部署、sandbox 运行时兼容、生产环境 Chromium DevTools 禁用、知识文档读取工具，以及 OTC 公司行为提醒插件接入。

## 决策

- 保留现有本地代码改动，不回滚用户已有工作。
- 推送前检查差异和敏感字段，避免将真实密钥提交到 GitHub。
- Docker 镜像打包公共插件和工作区插件，`logyi-mcp` 作为 MCP 服务单独构建。
- 生产/UAT 环境默认禁用 Chromium DevTools MCP，避免 agent 反复调用不可用浏览器。
- sandbox Python 运行时改为自动发现可执行 Python，并在 bubblewrap 不可用时退回普通执行。
- 新增 `read_knowledge_document` 工具，允许 agent 在权限范围内读取 `search_knowledge` 命中的导入文档全文。
- `otcclaw` 接入公司行为提醒插件工具与提示词规则。

## 改动清单

- `Dockerfile`、`Dockerfile.dockerignore`
  - 增加工作区插件构建与运行时加载路径。
  - 增加 sandbox 常用 Python、Node、ripgrep、bubblewrap 等运行依赖。
- `docker-compose.yml`
  - Samata 连接外部 `samata-wind-sync` 网络和 `wind_sync_pg`。
  - 增加企业 DNS、Langfuse 容器内地址、docs profile。
- `docs/platform/deployment.md`
  - 更新 Docker 部署、外部 Postgres、sandbox、Chromium 工具限制和 docs profile 说明。
- `.env.example`、`README.md`
  - 移除遗留 InfluxDB 配置说明。
- `src/commands/sandbox.ts`
  - 支持 `SANDBOX_PYTHON_BIN` / `SANDBOX_PYTHON_ROOT`。
  - 为 sandbox `.bin` 准备 Python、Node、npm、npx。
  - bubblewrap 可用性改为实际试跑检测。
- `src/runtime/chromium-tools.ts`、`src/services/mcp-manager.ts`、`src/llm/agents/prompt.ts`、`src/tools/agent-tools.ts`、`src/tools/system-tools.ts`
  - 生产默认禁用 Chromium/DevTools MCP，并同步过滤 prompt、工具列表和调用入口。
- `src/tools/knowledge-tools.ts`、`src/llm/tool-types.ts`、`src/llm/agents/config.ts`、`config/agents/ticlaw.md`
  - 新增 `read_knowledge_document` 工具并加入 common tool set。
- `config/agents/otcclaw.md`、`src/db/schema.ts`、`config/corporate-action-alert.json`
  - 接入公司行为提醒工具、权限迁移和插件运行配置。

## 验证命令

```text
npm run test:unit
npx tsc --noEmit
docker compose --env-file /dev/null config
```

## 验证结果

```text
npm run test:unit
# Test Files 14 passed (14), Tests 128 passed (128)

npx tsc --noEmit
# passed

docker compose --env-file /dev/null config
# compose config rendered successfully
```

## Commit Hash

2a88d7959b1a315b262b97146561b7558b3df9e0
