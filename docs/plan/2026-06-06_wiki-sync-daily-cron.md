# Wiki 每日定时同步

## 背景

用户确认需要让 Samata 每日自动同步内部 Confluence Wiki。前序排查已确认 ticlaw 文档表与 `parsed.md` 已补齐：`documents` 中 ticlaw 文档 10522 条，本地 `parsed.md` 10522 个，缺失 0 个。剩余问题是把一次性补数能力固化为运行时定时任务，并避免 Wiki 页面更新时删除旧文档造成 `document_id` 变化。

wiki-sync 原设计依赖 `cf-export`，但容器内验证发现 PyPI 版 `confluence-markdown-exporter==3.2.0` 不适合无人值守每日任务：它不支持原文档中假设的 `--cleanup-stale` / lockfile，默认 frontmatter 不包含 `confluence_page_id/version`，复杂页面还会触发交互式 Jira/宏配置导致非 TTY 下 `Aborted`。因此本次改为由 wiki-sync 插件直接调用 Confluence REST API 导出 HTML，并用 Turndown 转 Markdown。

## 决策

- 使用 `wiki-sync` 插件内置 cron 作为每日同步机制，不额外引入宿主机 crontab。
- 每日同步时间设为北京时间 `02:00`，cron 表达式为 `0 2 * * *`。
- Samata 容器统一设置 `TZ=Asia/Chongqing`，避免 cron 使用 UTC 造成触发时间偏移。
- 不再依赖 `cf-export` 作为每日同步主路径；wiki-sync 内置 REST exporter 自行生成 Markdown、frontmatter 和 `confluence-lock.json`。
- wiki-sync 配置放在运行时数据目录：`/app/samata/data/plugins/wiki-sync/config.yaml`，敏感 token 不入库。
- 每日增量先拉 Confluence 页面版本列表，只导出新增/变更页，避免每天全量重导 1 万余页。
- 对已有 Wiki 页面更新时保留原 `document_id`，直接更新对应 `original.md`、`parsed.md` 和 `documents` 表元数据；新增页面仍走 `/doc-import`。
- 运行时 snapshot 从现有数据库与历史 snapshot 重建，避免每日增量误判为全量导入。

## 改动清单

- `Dockerfile`
  - 增加 `TZ=Asia/Chongqing`。
- `docker-compose.yml`
  - 为 `samata` 服务增加 `TZ=Asia/Chongqing`。
- 运行时数据目录
  - 新增 `/home/xj/work/source/samata/data/plugins/wiki-sync/config.yaml`，用于容器内定时任务读取真实 Wiki/Samata 配置。
  - 重建 `/home/xj/work/source/samata/data/plugins/wiki-sync/snapshot.json`，记录 10513 个 Confluence 页面与现有 `document_id` 映射。

## 验证命令

- 已执行：`git pull --ff-only`
- 已执行：`npm run build -w wiki-sync`
- 已执行：wiki-sync 原地更新逻辑临时数据副本验证，确认 `document_id=0b641920` 保持不变，`parsed.md` 与 DB 元数据更新成功。
- 已执行：`docker compose build samata`
- 已执行：`docker compose up -d samata`
- 已执行：`docker exec samata date`，确认容器时间为 CST。
- 已执行：`docker logs samata` 检查 `[wiki-sync] cron 已启动 (schedule: 0 2 * * *, tz: Asia/Chongqing, config: /app/samata/data/plugins/wiki-sync/config.yaml)`。
- 已执行：容器内 `wiki-sync status`，确认 snapshot 10513 个页面。
- 已执行：容器内临时目录单页 REST export smoke test，确认导出页面 `244685395`、生成 `confluence-lock.json`、frontmatter 含 `confluence_page_id`。

## 构建与发布

- 该改动影响 Docker image、运行时容器环境和插件依赖，需要重建 Samata image 并重启 `samata` 服务。
- 主仓同时配置 `origin` 与 `github` remote；若执行 push，需向两个 remote 推送同一分支。

## Commit Hash

- 实现提交：`5a723bedb72079a1152080d46e1dc1ac8d6d2af5`
- 留档回填提交：本段由后续文档提交记录。
