---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# OtcClaw Langfuse 容器命名固定

## 背景

本地 Langfuse 全家桶已切换为 `dockertest.gf.com.cn/titans/otcclaw-langfuse-*` 镜像，但 Docker Compose 默认生成的容器名仍是 `samata-langfuse-*-1`。用户希望 `docker ps` 的 `NAMES` 与镜像名称保持一致，便于部署排查和运行态识别。

## 决策

1. 在 `docker-compose.langfuse.yml` 中使用 `container_name` 固定 Langfuse 全家桶容器名。
2. 容器名按 dockertest 镜像 basename 对齐：`otcclaw-langfuse`、`otcclaw-langfuse-worker`、`otcclaw-langfuse-clickhouse-server`、`otcclaw-langfuse-minio`、`otcclaw-langfuse-redis`、`otcclaw-langfuse-postgres`。
3. 继续保留 Compose service 名和内部 DNS 名，例如 `langfuse-web`、`langfuse-postgres`，避免影响 OtcClaw 到 Langfuse 的网络访问和 Langfuse 内部依赖配置。
4. 接受固定 `container_name` 的约束：同一台 Docker host 不适合并行启动多套同名 Langfuse 栈。

## 改动清单

- `docker-compose.langfuse.yml`
  - 为 Langfuse web、worker、ClickHouse、MinIO、Redis、Postgres 增加固定容器名。
- `package.json` / `package-lock.json`
  - 版本从 `3.0.21` 递增到 `3.0.22`。

## 验证命令

已执行：

```bash
docker compose --env-file .env.langfuse -f docker-compose.langfuse.yml config --quiet
docker compose --env-file .env.langfuse -f docker-compose.langfuse.yml up -d --no-build langfuse-postgres langfuse-clickhouse langfuse-redis langfuse-minio langfuse-worker langfuse-web
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | rg 'otcclaw-langfuse|otcclaw|wind_sync'
curl -fsS http://127.0.0.1:3001/api/public/health
docker exec otcclaw node -e "fetch('http://langfuse-web:3000/api/public/health').then(async r=>{console.log(r.status); console.log((await r.text()).slice(0,200)); process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message); process.exit(1)})"
npm run docs:plan-sync
```

结果：

- Compose 配置校验通过。
- 渲染后的 `container_name` 与 dockertest 镜像 basename 对齐。
- Langfuse 全家桶已用 `--force-recreate` 原地重建，`docker ps` 显示 `otcclaw-langfuse-*` 容器名。
- `http://127.0.0.1:3001/api/public/health` 返回 `{"status":"OK","version":"3.175.0"}`。
- OtcClaw 容器内访问 `http://langfuse-web:3000/api/public/health` 返回 `200`。
- `npm run docs:plan-sync` 已执行；仓库既有旧 plan 仍打印 frontmatter 警告/错误，本次新增 plan 已包含 `docModules`、`docTopics` 和 `canonicalDocs`。

## Commit

- implementation commit hash：`59c7f28`

## 构建与重启影响

本次改动只影响 Compose 容器命名和项目版本号，不改变应用运行时代码、依赖安装内容或数据库迁移。需要重新执行 `docker compose up -d --no-build` recreate Langfuse 全家桶容器以应用新容器名；named volumes 不删除，Langfuse 数据保留。
