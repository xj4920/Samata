---
docModules:
  - platform
  - permissions
docTopics:
  platform: 部署与运行
  permissions: 工具可见性
canonicalDocs:
  - /platform/deployment
  - /permissions/tool-access
status: implemented
---

# 本地生产 Compose 对齐与 Samata PostgreSQL 迁移

> 2026-07-22 后续决策：SBL 插件已改为使用 CSV `close_price`，本文中关于
> `samata_sbl_reader`、`WIND_PG_*`、`sbl-wind-check` 和外部 Wind 网络的设计已失效。
> 当前生产运行时不再连接 Wind DB；旧 `wind_sync_pg/samata` 仅保留为历史业务库迁移源。
> 现行设计见 [Samata 移除 Wind DB 依赖](./2026-07-22_remove-wind-db-dependency.md)。

## 背景

生产发布平台只识别 `{{string "..."}}` 模板参数，原本地 Compose 则依赖
`${ENV}`、源码 build、`/opt/samata/.env` 挂载和多个叠加文件。两套入口容易漂移。
同时，Fast Trading、Normal Trading、Hedge 和用户问题等插件业务表仍写入
`wind_sync_pg/samata`；生产已经不再使用 Wind PostgreSQL、InfluxDB 和 MiniMax
图像/视频生成。后续需求复核确认生产仍需 `analyze_sbl_usage`，因此保留
`wind_sync` 作为该工具唯一的外部只读行情源。

实施前现场只读审计确认：

- `wind_sync_pg/samata` 有 12 张用户表，约 316 万行；
- 最大表 `samata_hedge_holdings` 约 595 MB；
- Langfuse PostgreSQL 实例当前只有 `langfuse` 和 `postgres` 数据库；
- Samata 核心用户、Agent、memory 等数据仍使用 SQLite；
- Langfuse trace 由 SDK 通过 HTTP 写入 Langfuse，不由 Samata 直写 Langfuse 数据库。

## 核心决策

1. Git 中的 `docker-compose.yml` 作为唯一生产模板，保留所有平台占位符；本地只运行动态生成的 `/opt/samata/docker-compose.yml`。
2. 主模板合并 OtcClaw 与 Langfuse 全栈，生产不包含 build 和 docs 服务；本地镜像 build 放到 `docker-compose.local.yml`。
3. `.env` 和 `.env.langfuse` 只作为本地渲染输入，不挂载、也不作为 Compose `env_file`。
4. 使用全新的 PostgreSQL 16 实例，PGDATA bind 到
   `/opt/samata/data/postgres`；实例内分别创建 `langfuse/langfuse` 和
   `samata_app/samata` 两套账号/数据库，绝不把业务表写进 `langfuse` 数据库。
5. 业务插件统一通过 `LOG_PG_*` 连接 `langfuse-postgres/samata`，删除 Wind PG 和重复 Fast PG 配置。
6. 迁移脚本只迁移旧 `wind_sync_pg/samata`；不迁移 `wind_sync`，也不导出或恢复旧
   Langfuse PostgreSQL、ClickHouse、MinIO 历史。
7. `SAMATA_DISABLED_TOOLS` 是最终运行时 deny list，在 Agent、用户、universal、MCP 和 channel 策略后应用，并在实际执行入口再次校验。
8. 生产固定禁用 `generate_image`、`generate_video`；保留图片发送、Markdown 转图、
   视觉识别、`sync_sbl_data` 和 `analyze_sbl_usage`。
9. 所有业务插件共用一组 `SFTP_*` 运行时配置；生产外露 `SFTP_HOST`、`SFTP_USER`、
   `SFTP_PASSWORD` 三项，port 和 Fast/Normal/Corporate Action/SBL/Hedge 的八个业务
   远端目录固定在 Compose，
   由 Samata 启动期在进程内派生现有插件兼容变量，避免生产模板重复参数、
   跨仓接口改动和目录串用。
10. `analyze_sbl_usage` 继续只读
    `wind_sync.public."ASHAREEODPRICES"`；OtcClaw 接入既有外部
    `samata-wind-sync` 网络，host/port/database/user 固定，只外露
    `WIND_PG_PASSWORD`。专用 `samata_sbl_reader` 不复用现有 PostgreSQL 超级用户；
    其业务数据访问收敛为目标表 `SELECT`，另保留数据库 `CONNECT`、`public` schema
    `USAGE` 和系统对象所需权限。数据库可能经 `PUBLIC` 继承 `TEMP`，类型具有隐式
    `PUBLIC USAGE`，这是接受的例外；风险由默认事务只读、连接上限、超时、`work_mem`
    和 `temp_file_limit` 共同控制，文档不再声称账号绝对只有 `SELECT`。
11. Langfuse ClickHouse/MinIO 使用全新 `otcclaw_prod_langfuse_*_v1` 命名卷；旧
    `samata_langfuse_*` 卷保留但不挂载。OtcClaw 的 data 父挂载上叠加 `nocopy` 只读空卷，
    遮蔽 `/app/samata/data/postgres`，避免应用访问或递归改权 PGDATA。

## 改动清单

### Compose 与本地生成

- `docker-compose.yml`
  - 改为生产镜像模板，使用 `docker_repo`、`image_version` 和显式配置参数；
  - 合并 Langfuse Web、Worker、PostgreSQL、ClickHouse、MinIO、Redis；
  - 新增幂等 `samata-postgres-init` 服务；
  - PostgreSQL bind `/opt/samata/data/postgres`，并为 OtcClaw 增加嵌套只读 guard；
  - 增加仅接入 `samata-wind-sync` 的一次性 `sbl-wind-check` 服务；它通过 reader
    实际核对数据库/版本、角色属性与成员、角色设置、数据库/schema、表与列、序列、
    用户函数、类型直接权限、large object、parameter、显式 default ACL、目标精确索引
    和非空行情数据；管理端独立检查 SCRAM verifier，外部探针以 `pg_isready`、错误密码
    拒绝和紧随其后的正确密码全量检查共同排除 `trust`/网络误判；OtcClaw 必须等检查
    通过后才能启动；
  - ClickHouse/MinIO 切换到
    `otcclaw_prod_langfuse_clickhouse_data_v1`、
    `otcclaw_prod_langfuse_clickhouse_logs_v1`、
    `otcclaw_prod_langfuse_minio_data_v1`，不复用旧历史；
  - 删除 `.env` 挂载、docs、build 和旧 Wind Compose 叠加文件；OtcClaw 仅为 SBL
    收盘价查询保留外部 `samata-wind-sync` 网络；
  - OtcClaw 业务 PG 固定连接 `langfuse-postgres/samata`。
- 删除 `docker-compose.langfuse.yml` 和 `docker-compose.wind-sync.yml`。
- 新增 `docker-compose.local.yml`，只承载本地 OtcClaw 镜像构建。
- 新增 `scripts/render-local-compose.mjs`
  - 支持重复 `--env-file`、镜像参数覆盖和自定义输出；
  - 缺少参数时只输出参数名；
  - 对 YAML 单引号和 Docker Compose `$` 插值做安全转义；
  - 临时文件 `0600`、Compose 校验、原子替换、上次结果备份；
  - 拒绝源/目标同路径，渲染前后校验源模板摘要。
- 重构 `scripts/deploy-otcclaw.sh`、`scripts/docker-samata.sh`，所有启动都先生成运行
  Compose；正式 render/deploy/up 与迁移共享可信 `/opt/samata` 目录 inode 锁，低层
  renderer 和直接 Compose 仍可用于校验/应急，但不得在迁移期间并发运行。
- `scripts/analyze-log.ts` 与历史 Influx 导入脚本不再使用 `wind_sync` 账号/本机 PG
  作为缺省写入目标；显式运行时回退到新的 `SAMATA_POSTGRES_*`。

### 数据迁移

- 新增 `scripts/migrate-samata-postgres.sh`
  - `--dry-run` 只读检查 Compose storage contract、源身份/版本/表数、目标路径为空、
    fresh 卷不存在和磁盘预算；
  - `--execute` 先拉取并 inspect 全部目标镜像，再执行完整外部 Wind 门禁；全部通过后
    才停止 OtcClaw、确认无其它源客户端，并只生成 `wind_sync_pg/samata`
    custom-format dump，不备份旧 Langfuse；
  - dump 前后复查活动连接并比较 source insert/update/delete 累计计数；正式窗口必须同步
    暂停所有外部 `samata` writer；停止旧栈后、替换目标 PG 前再次复查，发现重连或写入
    就在破坏性步骤前中止；
  - 进入停写窗口前以 `missing` 策略补齐目标镜像并完成 Wind reader 的完整角色、ACL、
    数据与外部正负认证检查，既复用本地新构建 tag，也保证 registry 或外部门禁失败时
    旧服务继续运行；
  - 迁移持有可信目录锁并复制 `0600` 临时 Compose 快照，固定后续镜像、密码、环境和
    Compose project；backup root 与 PGDATA 重叠会在停机前拒绝；
  - 删除旧 PostgreSQL 容器前，通过无网络、只读 rootfs 的短生命周期 PostgreSQL helper
    创建 `999:999/0700` PGDATA bind，并用唯一 claim label 原子认领三个 fresh v1 卷；
    启动前再次确认卷未被其它容器挂载；
  - 失败清理只删除仍属于本次 claim 且无任何容器引用的未使用 fresh 卷；legacy、外部
    创建和已挂载卷始终保留；
  - Compose 快照清理为 best-effort，失败只告警而不阻断关键恢复；`SIGKILL`、宿主机
    掉电或 Docker daemon 中断留下的 PGDATA、stale claim 和 `0600` 临时快照由下次
    fail-closed 门禁拦截，并按部署文档人工核查；
  - 先启动 fresh PostgreSQL，验证实际 mount，再初始化 `samata_app/samata` 并恢复；
  - 精确比较逐表行数、catalog 九类对象、序列状态和 relation owner；
  - 校验成功后先启动 fresh Langfuse，在 OtcClaw 启动前再次执行完整 Wind 门禁；通过后
    启动 OtcClaw，等待 `/health`，验证业务连接与 PGDATA guard，再执行末次 Wind 门禁；
  - OtcClaw 启动或末检失败会停止 OtcClaw；替换目标 PG 前失败自动恢复已停容器，替换后
    的其它失败不自动启动 OtcClaw；
  - 源库、dump、验证报告和旧卷保留，便于人工恢复。
- 新增 `scripts/provision-sbl-wind-reader.sh` 和配套 SQL：
  - 缺省 dry-run，只读确认 `wind_sync_pg/wind_sync`、目标表和角色权限；
  - `--check` / `--execute` 必须显式提供由 `openssl rand -hex 32` 生成的 64 位
    十六进制 `WIND_PG_PASSWORD`；
  - provision SQL 以单个事务幂等创建或轮换 `samata_sbl_reader`，角色固定为非超级用户、
    非建库/建角/复制/继承/BYPASSRLS 账号，`VALID UNTIL infinity`，清除双向角色成员和
    额外的全局/当前数据库角色设置，连接上限为 4，并强制按 SCRAM-SHA-256 存储密码；
  - 固定默认事务只读、查询/会话/锁超时、`temp_file_limit=0`、`work_mem=4MB` 和受限
    `search_path`；
  - 收敛数据库/schema/表与列/序列/函数/类型、large object、configuration parameter
    的直接 ACL 和账号显式 default ACL；业务数据访问只允许
    `public."ASHAREEODPRICES"` 的 `SELECT`；
  - 接受 PostgreSQL 经 `PUBLIC` 继承数据库 `TEMP` 及类型隐式 `PUBLIC USAGE` 的例外；
    新增函数 owner 需要显式收紧隐式 `PUBLIC EXECUTE` default privilege，部署门禁复查
    所有当前用户函数，不将账号误述为绝对“仅 SELECT”；
  - 密码通过 `docker exec` 环境继承与 psql `\getenv` 传入，不打印、不写命令参数。
- 新增 `scripts/check-sbl-wind-access.sh`：
  - 从已渲染 Compose 安全提取 reader password，不回显；
  - 校验固定 Wind 环境、外部网络和“Wind 服务不由主 Compose 部署”的合同；
  - 调用 provision `--check` 严格检查角色、成员、角色设置、持久对象有效 ACL、网络归属、
    TCP 密码认证、目标索引和非空行情数据；
  - 从该服务提取同一 image 与严格检查命令，通过不挂载卷的临时 `docker run` 客户端在
    外部网络复查数据库/schema、表与列、序列、函数、类型直接权限、large object、
    parameter、显式 default ACL；管理端检查 SCRAM verifier，外部错误密码负测只验证
    密码拒绝/非 `trust`，并由前置 `pg_isready` 与后续正确密码检查约束网络可达性；
    检查不会创建 Compose 默认网络或 Langfuse 命名卷；
  - deploy/up 在 OtcClaw 启动前 fail-fast；正式迁移在全部镜像就绪且停机前、OtcClaw
    启动前和启动健康后分别复核。

### 环境变量

- 本机 `.env` 已按 `.env.example` 重排并清理，既有真实值不输出：
  - 删除 `PG_WIND_*`、多余 `WIND_PG_*`、InfluxDB、MiniMax、Gemini、Anthropic model、
    `TELEGRAM_ADMIN_IDS`、任务级 provider/model、重复 Fast PG、OpenRouter、DeepSeek；
  - 精简为 17 个生产输入：2 个镜像、4 个 Custom 模型、Serper、SFTP host/user/password、
    Wind reader password、Hedge 邮箱 4 项、LogYi key 和 Samata PG password；
  - SFTP 统一外露 host/user/password；LogYi 两个 MCP 只外露同一个 `LOGYI_API_KEY`；
  - 新增 `WIND_PG_PASSWORD` 空输入，必须在创建 `samata_sbl_reader` 时由运维安全填写，
    不从正在运行的容器反向导出密码；
  - `SAMATA_POSTGRES_USER/DATABASE`、工具策略和运行默认值固定在 Compose。
- 当前现场仍保持 fail closed：`samata_sbl_reader` 不存在，仓库本地 `.env` 的
  `WIND_PG_PASSWORD` 为空，`/opt/samata/docker-compose.yml` 仍是旧渲染文件；正式
  migration/deploy/up 必须等强密码、provision、重新渲染和完整外部门禁全部完成。
- `.env.langfuse` 精简为 11 个输入，只保留 URL、服务密钥、存储密码、项目 key 和首次
  管理员密码；
  - 项目初始化与 Samata SDK 共用 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`。
- 生产模板唯一占位符从 63 个收敛为 28 个，示例文件与模板有精确一致性测试。
- 更新 `.env.example`、`.env.langfuse.example`。

### 工具运行时策略

- 新增 `src/runtime/tool-policy.ts`，解析、去重、过滤全局禁用工具。
- 新增 `src/runtime/sftp-env.ts`，在插件加载前把统一 `SFTP_*` 参数派生成旧插件兼容变量；
  Compose 本身不再暴露旧变量名。
- Agent 最终工具集合、native、plugin、MCP、统一执行入口和定时任务创建均增加校验。
- 增加 standard、all、user-all、universal、MCP、直接执行和定时任务测试。

### 文档与版本

- 更新 `README.md` 与 `docs/platform/deployment.md`。
- 根版本由 `3.0.30` 升至 `3.0.31`，同步 `package-lock.json`。

## 数据流

```text
仓库 .env + .env.langfuse
        │ 仅作为输入
        ▼
render-local-compose.mjs
        │ 校验、原子写入
        ▼
/opt/samata/docker-compose.yml
        ├── OtcClaw ──HTTP──> fresh Langfuse Web
        │                   ├── langfuse DB（fresh 配置/项目）
        │                   └── fresh ClickHouse/MinIO/Redis
        ├── 业务插件 ───────> samata DB（从 wind_sync_pg/samata 迁入）
        │                     │ 同一个 fresh PostgreSQL 实例
        │                     ▼
        │            /opt/samata/data/postgres
        └── SBL 分析 ───────> wind_sync_pg/wind_sync
                              业务数据仅 SELECT ASHAREEODPRICES
                              （另需 CONNECT/schema USAGE；PUBLIC TEMP
                              与类型隐式 PUBLIC USAGE 为接受的例外）

OtcClaw /app/samata/data/postgres ──> nocopy 只读空卷（遮蔽真实 PGDATA）
```

## 验证命令

已执行的仓库验证：

```bash
npx vitest run tests/unit/runtime/tool-policy.test.ts \
  tests/unit/runtime/sftp-env.test.ts \
  tests/unit/config/agent-config.test.ts \
  tests/unit/tools/schedule.test.ts \
  tests/unit/scripts/render-local-compose.test.ts
npm test
npx tsc --noEmit
WIND_PG_PASSWORD=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  node scripts/render-local-compose.mjs --output /tmp/samata-compose/docker-compose.yml
docker compose --env-file /dev/null -f /tmp/samata-compose/docker-compose.yml config --quiet
bash -n scripts/migrate-samata-postgres.sh scripts/deploy-otcclaw.sh \
  scripts/docker-samata.sh scripts/provision-sbl-wind-reader.sh \
  scripts/check-sbl-wind-access.sh
node --check scripts/render-local-compose.mjs
git diff --check
npm run check-readme
npx vitepress build docs
npm run docs:plan-sync -- --check
DOCKER_REPO=dockertest.gf.com.cn bash scripts/docker-samata.sh build
```

现场补齐强密码、reader 与最新渲染文件后，正式执行前必须再运行：

```bash
bash scripts/provision-sbl-wind-reader.sh --check
SAMATA_COMPOSE_FILE=/opt/samata/docker-compose.yml \
  bash scripts/check-sbl-wind-access.sh
SAMATA_COMPOSE_FILE=/opt/samata/docker-compose.yml \
  bash scripts/migrate-samata-postgres.sh --dry-run
```

实测结果：

- 5 个定向 test files、61 个 tests 全部通过，覆盖全局工具策略、统一 SFTP 环境派生、
  Agent 配置、定时任务和本地 Compose 渲染。
- 全量 `npm test` 通过：38 个 test files、236 个 tests。
- `npx tsc --noEmit`、相关脚本 `bash -n`、Node 语法检查和 `git diff --check` 通过。
- `npm run check-readme` 与独立 `npx vitepress build docs` 通过；构建只有既有的
  高亮语言和 chunk size 警告。
- `npm run docs:plan-sync -- --check` 确认生成索引已是最新，但仍被 11 个既有或本任务
  范围外 plan 文档的历史 frontmatter/canonicalDocs 错误阻断；本计划 frontmatter 未
  报错，且独立 VitePress 构建已通过。
- 28 参数哨兵值渲染成功，生成文件权限为 `0600`，Docker Compose
  `config --quiet` 通过。
- 隔离 PostgreSQL 16 验证通过：provision 首次执行、主动制造双向角色成员、全局/
  当前数据库设置、角色有效期、表/类型/large object/parameter/default ACL 漂移后的
  收敛、幂等复跑、外部网络服务可达、正确密码正向认证、错误密码负向认证、目标表查询
  和写入拒绝。
- 现场迁移 dry-run 通过：源固定为 `wind_sync_pg/samata`（12 张用户表、约 633 MiB），
  预算至少 3556 MiB，可用约 29921 MiB；前后运行容器和 Docker 卷清单一致，未停止
  容器、创建卷或修改数据库；backup/PGDATA 重叠与共享锁并发场景均按预期阻断。
- 最终独立迁移安全复核未发现 P0/P1；目标替换前的源库/OtcClaw 复查已移动到 PGDATA
  与 fresh 卷复查之后，Compose 快照删除改为不阻断恢复的 best-effort。数据库级停写
  栅栏以及 `SIGKILL`/掉电无法运行 trap 的边界已在部署文档中明确，正式窗口仍必须暂停
  全部外部 writer。
- 2026-07-21 现场执行中修正两项继续迁移所需问题：MinIO 使用 `sh -ec` 加单一命令参数，
  避免 Docker 把 `mkdir` 作为唯一 shell 命令；迁移 owner 校验排除 `pg_toast%` 系统
  schema，避免把不可改 owner 的 TOAST 索引误计为业务对象。
- 2026-07-21 按部署参数精简要求，将 `NEXTAUTH_URL` 从 Langfuse 必填输入中移出；渲染
  阶段默认检测容器宿主机 IP 并生成 `http://<host-ip>:3001`，显式配置仍可覆盖。
- 2026-07-21 按部署文档要求，在 README 中补充完整 docker-compose 参数表，逐项说明
  参数分类、是否必填、用途和参考配置值；真实密钥继续只给生成方式或占位示例。
- OtcClaw image 已按最终运行时代码重建：
  `dockertest.gf.com.cn/titans/otcclaw:v3.0.31-0720181627928`，
  image ID `sha256:eaac0b743c46edf3d4677ecb89eeeee6a455971d7386b6cb49502443a2ab3331`；
  OCI version 为 `3.0.31`，构建环境未能捕获 revision，故 label 为 `unknown`。无网络
  临时容器已确认最新八目录 SFTP 兼容映射和工具禁用策略进入镜像。
- 当前现场门禁尚未通过：`samata_sbl_reader` 不存在，仓库本地 `.env` 的
  `WIND_PG_PASSWORD` 为空，`/opt/samata/docker-compose.yml` 仍是旧渲染文件。因此未执行
  正式容器启动/重启或 PostgreSQL 迁移；完成 provision、重新渲染和完整外部门禁前保持
  fail closed。
- 2026-07-21 现场正式迁移已完成：
  - 生成新的 64 hex `WIND_PG_PASSWORD` 并写入仓库本地 `.env`，创建/收敛
    `samata_sbl_reader`；
  - 重新生成 `/opt/samata/docker-compose.yml`；
  - `wind_sync_pg/samata` dump 写入
    `/opt/samata/backups/postgres-migration/20260721-110101/`；
  - fresh PostgreSQL 使用 bind mount `/opt/samata/data/postgres`；
  - 行数、catalog、sequence 对比全部通过，public schema 中 12 tables、38 indexes、
    4 sequences 均归 `samata_app`；
  - fresh Langfuse、OtcClaw 与 Wind 外部门禁全部启动/验证通过；
  - 旧 `wind_sync_pg/samata`、`wind_sync_pg/wind_sync` 和旧 Langfuse volumes 均保留。

正式迁移需在单独确认停写窗口后执行：

```bash
bash scripts/migrate-samata-postgres.sh --execute
```

迁移后还需验证逐表行数、插件读写、Langfuse trace、目标/源连接以及容器健康状态。

## Commit

- implementation commit hash：待提交

## 构建、重启与迁移影响

- 整体改动包含运行时代码、Compose 和镜像版本变化；OtcClaw image 已在本机按最终源码
  完成重建和产物检查，但尚未推送 registry，也未用于重启现有服务。
- Langfuse 镜像本身未修改，不需要重新构建。
- 不涉及 SQLite schema migration。
- 涉及 PostgreSQL 业务数据迁移和 OtcClaw 停写窗口；实施阶段仅提供脚本并执行 dry-run，
  不自动执行正式迁移或重启现有生产容器。
