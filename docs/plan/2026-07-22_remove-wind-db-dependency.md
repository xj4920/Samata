---
docModules:
  - platform
  - external-data
  - permissions
docTopics:
  platform: 部署与运行
  external-data: 数据源退役
  permissions: 文件与沙箱白名单
canonicalDocs:
  - /platform/deployment
  - /external-data/
  - /permissions/file-and-sandbox-allowlist
status: implemented
---

# Samata 移除 Wind DB 依赖

## 背景

SBL 插件已在 `c427701a9e4bd6efa3ac28cadc8627d6cb2e9fab` 改为直接使用
`borrow_YYYYMMDD.csv` 与 `trades_YYYYMMDD.csv` 的 `close_price`。Samata 生产模板仍保留
Wind reader、外部网络和启动门禁，Agent 提示词及 sandbox 也仍暴露通用 Wind 查询入口，
导致运行时继续依赖已不需要的 Wind PostgreSQL。

## 决策

- SBL 唯一数据流固定为 `SFTP CSV -> close_price 校验 -> 数量/市值/使用率`。
- 生产 Compose 不声明 `WIND_PG_*`、`sbl-wind-check` 或外部 Wind 网络。
- Agent 不再获得 Wind 查询提示词、文档白名单、schema 文档或专用运维脚本。
- PostgreSQL 迁移脚本只保留从历史 `wind_sync_pg/samata` 搬迁 Samata 业务库的能力；
  它不访问该实例中的其它数据库，也不构成生产运行时依赖。
- 不停止、不删除外部 Wind 容器、网络或数据。

## 改动清单

- `docker-compose.yml`、`.env.example`
  - 删除 Wind 凭据、检查服务、依赖和网络。
- `scripts/deploy-otcclaw.sh`、`scripts/docker-samata.sh`
  - 删除部署前 Wind ACL 门禁。
- `scripts/migrate-samata-postgres.sh`
  - 删除 reader provision/check 调用；新增 Compose 和容器环境的无 Wind 断言。
- `config/agents/`、`src/tools/sandbox-tools.ts`
  - 删除 Wind 数据域、查询步骤、文件白名单和失败提示。
- `docs/`、Wind 专用脚本
  - 删除活动 Wind 查询/schema/索引维护入口，更新正式文档导航。
- `tests/unit/scripts/render-local-compose.test.ts`
  - 将外部 reader 合约测试改为 CSV-only/no-Wind 合约测试。
- `package.json`、`package-lock.json`
  - patch 版本递增到 `3.0.34`。

## 验证命令

```bash
npm run test:unit -- tests/unit/scripts/render-local-compose.test.ts \
  tests/unit/tools/file-tools-list-directory.test.ts
npx tsc --noEmit
npm run docs:check
npm run compose:render
docker compose --env-file /dev/null -f /opt/samata/docker-compose.yml config --quiet
npx vitest run sbl-data/tests/sbl-data.test.ts
npm run build --workspace=sbl-data
bash scripts/docker-samata.sh build
```

## 验证结果

- `git diff --check` 通过。
- 3 个 shell 脚本通过 `bash -n` 语法检查。
- 定向单测通过：2 个文件、17 个测试。
- 全量单测通过：46 个文件、255 个测试。
- `npx tsc --noEmit` 通过。
- SBL 插件单测通过：1 个文件、6 个测试；workspace build 通过。
- 本地生产 Compose 成功渲染，Docker Compose 配置校验通过，运行时不再包含
  `WIND_PG_*`、`sbl-wind-check` 或 `wind-sync`。
- VitePress 文档构建通过。`npm run docs:check` 仍被本次改动前已存在的 11 个历史
  PLAN 元数据问题阻断；本计划及本次删除文档相关的索引、链接错误均已修复。
- OtcClaw 镜像构建成功：`local/titans/otcclaw:v3.0.34-0722102442931`
  （digest `sha256:a3ea6244b7f41397a034fbf563f8452f031a36c8d1550b09480690a0b004934a`）。
- 镜像内 Samata 版本为 `3.0.34`；SBL `dist/index.js` 与插件仓产物 SHA-256
  均为 `50b87834e267bf9b32ded80277700f36bb5d76b3ccb3f1fed48eb03bc1b8f352`。
- 未重启或替换当前生产容器，未变更外部 Wind 容器、网络或数据库。

## 构建与部署影响

SBL 插件源码和 `dist` 会复制进 OtcClaw 镜像，因此必须重新构建 OtcClaw 镜像并重建
`otcclaw` 容器。无需数据库迁移，也无需重建 PostgreSQL、Langfuse 或其它服务镜像。

## Commit Hash

待提交。
