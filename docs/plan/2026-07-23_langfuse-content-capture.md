---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Langfuse Trace 正文采集

## 背景

生产 OtcClaw 原先设置 `LANGFUSE_CAPTURE_CONTENT=false`。Langfuse 因此只能展示字符数、
图片数和 `content_redacted: true`，无法在 trace Input 中查看用户原始提问。

## 决策

- 生产 Compose 将 `LANGFUSE_CAPTURE_CONTENT` 固定为 `true`，让新 trace 保存用户提问、
  模型回复以及工具输入输出。
- `LANGFUSE_CAPTURE_SYSTEM_PROMPT` 继续保持 `false`，避免上传 system prompt。
- 该开关在 OtcClaw 进程中读取，因此只重建 `otcclaw`，不重建 Langfuse 服务或数据组件。
- 历史 trace 已经只写入脱敏摘要，无法在启用开关后恢复正文。

## 改动清单

- `docker-compose.yml`
  - 将生产 OtcClaw 的 `LANGFUSE_CAPTURE_CONTENT` 从 `false` 改为 `true`。
- `README.md`、`docs/platform/deployment.md`
  - 说明采集范围、system prompt 边界及隐私要求。
- `tests/unit/scripts/render-local-compose.test.ts`
  - 增加正文采集与 system prompt 脱敏的 Compose 合约测试。
- 本次 Langfuse 相关变更将版本从 `3.1.1` 更新为 `3.1.2`。

## 验证命令

```bash
npm run test:unit -- tests/unit/scripts/render-local-compose.test.ts
git diff --check
docker inspect otcclaw --format '{{range .Config.Env}}{{println .}}{{end}}' |
  rg '^LANGFUSE_CAPTURE_(CONTENT|SYSTEM_PROMPT)='
docker inspect --format '{{.State.Health.Status}}' otcclaw
docker exec otcclaw node -e \
  "fetch('http://langfuse-web:3000/api/public/health').then(async r => {
    console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1)
  }).catch(e => { console.error(e.message); process.exit(1) })"
```

## 验证结果

- 定向 Compose 单测通过：1 个文件、17 项测试。
- `git diff --check` 通过。
- `/opt/samata/docker-compose.yml` 的 Compose 配置校验通过。
- 在共享部署锁保护下使用 `--no-deps --force-recreate` 仅重建 `otcclaw`；Langfuse
  Web、Worker、PostgreSQL、ClickHouse、Redis 和 MinIO 均保持原运行实例。
- 新 `otcclaw` 容器内环境变量为 `LANGFUSE_CAPTURE_CONTENT=true` 和
  `LANGFUSE_CAPTURE_SYSTEM_PROMPT=false`。
- `otcclaw` 健康状态为 `healthy`、重启计数为 `0`；容器内访问
  `http://langfuse-web:3000/api/public/health` 返回
  `200 {"status":"OK","version":"3.175.0"}`。
- 历史 trace 仍为脱敏摘要；需要通过重建后产生的新提问在 Langfuse UI 中确认正文展示。

## Commit Hash

- 实现提交：`a4a7053b39546590c9d6204112596f7b16b96cf5`。
- 留档回填提交：本段所在提交；按仓库规则将版本递增到 `3.1.3`。

## 构建与部署影响

本次只修改容器环境变量，不改变应用代码、镜像内容、依赖或数据库结构，无需构建 Docker
image，也不涉及数据库迁移。本次已完成 `otcclaw` 定向重建，新环境变量已加载。
