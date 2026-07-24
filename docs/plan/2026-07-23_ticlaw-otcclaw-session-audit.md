---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Ticlaw / OtcClaw 每日会话审计

## 背景

原有宿主机 crontab 在 23:30、23:35 分渠道调用 `scripts/analyze-log.ts`，依赖仓库路径和
宿主机 Node 环境，且只按 telemetry UTC 文件名读取，无法完整覆盖北京时间自然日。审计
结果只保存摘要，缺少完整问题、回复、结构化工具调用和可查询的执行状态。

## 决策

- 使用复用 OtcClaw 镜像的独立 `session-audit` sidecar；它不依赖 Langfuse Web/Worker，
  仅连接同一 PostgreSQL 实例中的 `samata_app/samata`。
- 调度时间固定为北京时间每日 23:30，范围精确限定 `ticlaw`、`otcclaw` 和人工渠道。
- 每次先重审前一日，再审计当日快照；次日重审补齐前一日 23:30–24:00 会话。
- sidecar 启动时执行同一幂等补跑，确保上线后先验证 PostgreSQL 写入，再迁移旧 cron。
- telemetry 按 UTC 日期分片，分析器读取前一 UTC 日到目标日的文件，再按北京时间过滤。
- `turn_id` 作为会话明细幂等键；每日执行状态以日期、Agent scope、source 为复合主键。
- 问题和回复各最多保存 100,000 字符，保留原始字符数和截断标记；Markdown 只展示摘要且
  文件权限为 `0600`。
- 旧宿主机 cron 只在 sidecar 健康后删除，删除前备份完整 crontab，且只匹配两条历史任务。

## 改动清单

- `src/telemetry/`、`src/db/schema.ts`、`src/db/migrations/`
  - telemetry 新增审计内容、字符数和截断字段，并兼容回填历史摘要。
- `scripts/analyze-log.ts`
  - 新增 Agent 精确过滤、人工渠道过滤、跨 UTC 分片的本地日期过滤、零数据审计状态、
    PostgreSQL 事务式幂等 upsert 和运行记录。
- `src/services/session-audit-scheduler.ts`、`scripts/session-audit-healthcheck.mjs`
  - 新增 23:30 调度、前一日 reconciliation、锁、heartbeat 和健康检查。
- `docker-compose.yml`、`scripts/migrate-samata-postgres.sh`
  - 新增 sidecar 及 PostgreSQL 迁移过程中的停启、健康和环境合约。
- `scripts/migrate-session-audit-crontab.sh`
  - 新增 dry-run、sidecar 健康门禁、完整备份和精确删除旧 cron。
- `README.md`、`docs/platform/deployment.md`、`docs/dream-mechanism.md`
  - 记录审计部署、运维查询，以及 Dream 当前由主进程内调度器触发的真实机制。
- `package.json`、`package-lock.json`
  - patch 版本从已占用的 `3.1.4` 递增到 `3.1.5`。

## 验证命令

```bash
npx tsc --noEmit
npm run test:unit -- tests/unit/services/session-audit-scheduler.test.ts \
  tests/unit/scripts/analyze-log-session-audit.test.ts \
  tests/unit/telemetry/emitter-audit-content.test.ts \
  tests/unit/schema/migrations.test.ts \
  tests/unit/scripts/render-local-compose.test.ts
bash -n scripts/migrate-samata-postgres.sh \
  scripts/migrate-session-audit-crontab.sh
node --check scripts/session-audit-healthcheck.mjs
npm run docs:check
bash scripts/docker-samata.sh build
```

## 验证结果

- `git diff --check`、两个 shell 脚本 `bash -n`、healthcheck `node --check` 通过。
- `npx tsc --noEmit` 通过。
- 定向单测通过：5 个文件、27 项测试；覆盖 23:30 调度、前日重审、本地日/UTC 分片边界、
  Agent/人工渠道过滤、内容截断与权限、SQLite migration、Compose 和旧 cron 合约。
- 全量单测通过：49 个文件、264 项测试。
- `docker compose --env-file /dev/null --file docker-compose.yml config --quiet` 通过。
- VitePress 独立构建通过。`npm run docs:check` 仍被本次改动前已存在的 11 个历史 PLAN
  frontmatter/失效 canonical link 问题阻断；本计划索引已同步且没有新增文档错误。
- 旧 cron dry-run 成功，只识别出 23:30 企微和 23:35 飞书两条历史任务，未执行删除。
- 历史回填首次遇到 PostgreSQL `jsonb` 不接受旧工具数据中的 NUL/不完整代理字符；事务
  完整回滚且执行状态记为 failed。增加 PostgreSQL 文本规范化后重新执行成功。
- 已向 `langfuse-postgres/samata` 回填 2026-06-19 至 2026-07-22：34 个日期全部
  `completed`，共 473 条明细（TIClaw 220、衍语 253），其中 408 条包含结构化工具调用；
  6 月 19–21 日及 7 月 12 日无 telemetry，会话数明确为 0。逐日运行计数与明细聚合差异
  为 0，473 个 `turn_id` 全部唯一。
- 提交前最终镜像重建成功：
  `local/titans/otcclaw:v3.1.5-0724175908758`
  （`sha256:e5884f09693c345453b1d7135b1351181350c18686dd25d3f34a74cc34fa8b34`）；
  镜像版本标签、审计调度器导入和 PostgreSQL 文本清洗代码检查均通过。
- 尚未部署或重启 sidecar，也未修改宿主机 crontab；需在提交确认、双远端 push 后执行。

## 构建与部署影响

必须重新构建并发布 OtcClaw 镜像，并创建 `otcclaw-session-audit` 容器。SQLite 审计字段由
应用 migration 自动增加；PostgreSQL 审计表由分析器幂等创建，不需要独立 SQL migration。
主 OtcClaw 和 sidecar 复用同一镜像，无需重建 Langfuse/PostgreSQL 服务镜像。

## Commit Hash

待提交后填写。
