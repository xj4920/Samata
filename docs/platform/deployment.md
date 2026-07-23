# 部署与模型

本地部署以 Node.js、SQLite 和配置文件为核心。生产或团队环境可以把插件目录、Agent prompt、Bot app 凭证和外部数据连接分开管理。

## 本地启动

```bash
npm install
cp .env.example .env
npm run server
npm run cli
```

## 数据库迁移与 Seed 边界

启动期会先执行 legacy `initSchema()`，用于基础建表和历史 `runOnce` 迁移；随后执行 Umzug migration runner。新增数据库迁移一律放在 `src/db/migrations/`，不要继续追加到 `src/db/schema.ts`。

```bash
npm run db:migrate
```

`npm run db:migrate` 复用 SQLite `migrations` 表记录执行状态，适合本地或部署前显式验证。默认 Agent / 默认成员这类平台基线仍由 legacy 初始化保证；开发、演示、业务插件绑定和 Bot 配置不应作为启动 seed 写入平台 schema。

## Bot 配置

飞书、企微和 Telegram Bot 配置以 SQLite `bot_apps` 和 `agent_assignments` 为准，通过 CLI 的 `/agent bot-app`、`/agent assign`、`/agent bot-app start|stop` 管理。`WEWORK_AIBOT_*` 不再作为自动写入 `bot_apps` 的入口；需要启用企微 Bot 时，先显式创建/绑定 Bot app，再启动服务或独立企微进程。

## Docker 部署

OtcClaw Docker 镜像会同时打包 Samata 主应用和同级目录下的源码插件：

```text
source/
  samata/
  samata-plugins/
  samata-plugin-work/
```

从 `samata/` 目录启动：

```bash
sudo install -d -m 0775 -o "$USER" -g "$(id -gn)" \
  /opt/samata /opt/samata/data /opt/samata/logs
sudo install -d -m 0700 -o "$USER" -g "$(id -gn)" /opt/samata/ssh
# 仅限没有历史 Samata 业务数据的全新环境。
sudo install -d -m 0700 -o 999 -g 999 /opt/samata/data/postgres
cp .env.example .env
cp .env.langfuse.example .env.langfuse
chmod 600 .env .env.langfuse
cp config/mcp-servers.example.json /opt/samata/mcp-servers.json
chmod 600 /opt/samata/mcp-servers.json
# 编辑仓库本地 .env / .env.langfuse；它们只作为渲染输入，不挂载进容器。
npm run compose:render
cd /opt/samata
docker compose --env-file /dev/null config --quiet
docker compose --env-file /dev/null pull
docker compose --env-file /dev/null up -d --no-build
```

仓库中的 `docker-compose.yml` 是生产平台模板，必须保留
`{{string "..."}}`，不能直接交给 Docker Compose。`scripts/render-local-compose.mjs`
读取仓库本地 `.env` 与 `.env.langfuse`，进行 YAML 和 `$` 安全转义，先执行
`docker compose config --quiet`，再原子写入 `/opt/samata/docker-compose.yml`。
生成文件权限为 `0600`，失败时不会覆盖上一次可用文件。

生成文件可在 `/opt/samata` 直接拉起服务，但直接 Compose 命令不会获取仓库脚本的共享
部署锁。迁移、`scripts/deploy-otcclaw.sh` 或 `scripts/docker-samata.sh up` 正在运行
时禁止并发执行；`docker-samata.sh build/push/prune` 只操作镜像，不持有运行时部署锁。
常规变更优先使用脚本入口。迁移脚本、`deploy-otcclaw.sh` 和 `docker-samata.sh up`
都会锁定可信的 `/opt/samata` 目录 inode，不创建可被符号链接替换的 `/tmp` 锁文件。

生成后的 Compose 已包含 OtcClaw、Langfuse Web/Worker、PostgreSQL、ClickHouse、
MinIO、Redis 和 Samata PostgreSQL 初始化服务；不包含 docs 服务。环境变量全部显式写入
生成文件，运行时不挂载 `.env`。MCP、data、logs、SSH 以及 PostgreSQL PGDATA 挂载都在
该文件中；PGDATA 固定绑定 `/opt/samata/data/postgres`。OtcClaw 的 data 父目录挂载之上
再用 `nocopy` 只读空卷遮蔽 `/app/samata/data/postgres`，因此应用看不到、也无法改权实际
PGDATA。Compose
环境可被宿主机 Docker 管理员查看，因此 `/opt/samata/docker-compose.yml` 必须按密钥文件
管理。所有直接操作都应显式带 `--env-file /dev/null`；如部署目录还留有旧 `.env`，应由
运维人员单独归档，数据库迁移脚本不会移动配置文件。

FTP/SFTP 统一保留 `SFTP_HOST`、`SFTP_USER`、`SFTP_PASSWORD` 三个部署参数。
Compose 固定端口 22，以及 Fast trades/summary、Normal trades/summary/details、
Corporate Action、SBL、Hedge 八个互相独立的远端目录。Samata 启动时会在进程内派生
现有插件仍在读取的兼容
变量；生产模板和 `.env` 不再重复端口或目录。

模板共有 27 个唯一参数，除此之外不需要在生产发布平台填写：

| 分类 | 参数 |
|------|------|
| 镜像 | `docker_repo`、`image_version` |
| Custom 模型 | `CUSTOM_API_KEY`、`CUSTOM_BASE_URL`、`CUSTOM_MODEL`、`CUSTOM_VISION_MODEL` |
| 外部服务 | `SERPER_API_KEY`、`SFTP_HOST`、`SFTP_USER`、`SFTP_PASSWORD`、`LOGYI_API_KEY` |
| Hedge 邮箱 | `HEDGE_RATIO_EMAIL_ADDRESS`、`HEDGE_RATIO_EMAIL_PASSWORD`、`HEDGE_RATIO_EMAIL_IMAP_SERVER`、`HEDGE_RATIO_EMAIL_IMAP_PORT` |
| Samata 业务库 | `SAMATA_POSTGRES_PASSWORD` |
| Langfuse | `NEXTAUTH_SECRET`、`SALT`、`ENCRYPTION_KEY`、`LANGFUSE_POSTGRES_PASSWORD`、`CLICKHOUSE_PASSWORD`、`MINIO_ROOT_PASSWORD`、`REDIS_AUTH`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`、`LANGFUSE_INIT_USER_PASSWORD` |

`.env.example` 对应前 16 项本地输入，`.env.langfuse.example` 对应后 10 项 Langfuse
必填输入。`NEXTAUTH_URL` 不填时会在渲染阶段自动生成为
`http://<容器宿主机 IP>:3001`；如果 Langfuse 通过域名、负载均衡或反向代理访问，再在
`.env.langfuse` 中显式覆盖。生产模板把 Samata DB 固定为 `samata_app/samata`，
ClickHouse/MinIO 用户、Langfuse 初始化 org/project/admin identity、tracing 策略、工具
轮次和默认 Agent 也都固定在 Compose。

如果镜像内存在 `/app/samata/docker-baseline/samata.db`，且运行目录中还没有 `/app/samata/data/samata.db`，entrypoint 会在启动时复制该 baseline 作为初始 SQLite 主库；已有数据库绝不覆盖。若同一镜像内还存在 `/app/samata/docker-baseline/data-files.tar.gz`，entrypoint 只会在这次 SQLite 首次初始化时解压其中的 `documents/`、`wiki/`、`plugins/`、`dreams/` 到运行目录，并写入 `data/.samata-data-baseline-restored` marker；已有运行库不会因为换镜像而覆盖文件数据。

发布镜像前通过以下命令从当前运行数据生成一致性 baseline：

```bash
npm run baseline:refresh
```

默认 SQLite 源库为 `/opt/samata/data/samata.db`，输出到 `docker-baseline/samata.db`。默认文件源目录为 `/opt/samata/data`，输出到 `docker-baseline/data-files.tar.gz`，manifest 输出到 `docker-baseline/data-files.manifest.json`。文件 baseline 只包含 `documents/`、`wiki/`、`plugins/`、`dreams/`；其中插件目录里的 SQLite 主文件会优先通过 SQLite backup API 生成一致性副本，`*.db-wal` / `*.db-shm` 等边车文件不会进入归档。两类 baseline 都被 `.gitignore` 忽略，只能进入受控 Docker registry。

如果部署环境里的插件需要通过 SSH 访问公司 Code 平台，例如 `titans-code-search` 同步 `libra-server`，需要在 `/opt/samata/ssh` 准备专用 SSH 配置。不要把个人完整 `~/.ssh` 目录挂进容器，只放最小必要文件：

```bash
install -m 700 -d /opt/samata/ssh
install -m 600 ~/.ssh/id_ed25519_gf /opt/samata/ssh/id_ed25519_gf
ssh-keyscan -p 30004 code.gf.com.cn > /opt/samata/ssh/known_hosts
chmod 644 /opt/samata/ssh/known_hosts
```

`/opt/samata/ssh/config` 建议固定为只允许 Code 平台使用专用 key，并启用严格 host key 校验：

```sshconfig
Host code.gf.com.cn
  HostName code.gf.com.cn
  Port 30004
  User git
  IdentityFile /home/node/.ssh/id_ed25519_gf
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile /home/node/.ssh/known_hosts
```

权限建议保持为：

```bash
chmod 600 /opt/samata/ssh/config /opt/samata/ssh/id_ed25519_gf
chmod 644 /opt/samata/ssh/known_hosts
```

修改 SSH 挂载后需要重建 `otcclaw` 容器挂载配置，但不需要重打镜像：

```bash
docker compose --env-file /dev/null up -d --no-build otcclaw
docker exec -u node otcclaw ssh -T code.gf.com.cn
docker exec -u node otcclaw git ls-remote --heads ssh://git@code.gf.com.cn:30004/gf/libra/libra-server.git release-1.68.x
```

镜像内 `/app/samata/config/agents` 会在构建和启动时授权给 `node` 用户，系统管理员可通过 CLI 工具创建或编辑 Agent prompt 文件。默认 compose 不持久化该目录，容器内临时创建的 prompt 会随着容器重建丢失；生产 Agent prompt 仍应提交到仓库的 `config/agents/<agent-name>.md` 并重新构建/部署镜像。Agent prompt 文件名按 `agent.name` 精确匹配；交互式 `/agent create` 要求小写英文名称，例如显示名可为 `OtcmsClaw`，但 name 和文件建议为 `otcmsclaw` / `config/agents/otcmsclaw.md`。

`npm run docker:otcclaw:up` 会从 `package.json` 读取版本号并生成主 tag：`otcclaw:v<version>-<MMddHHmmssSSS>`，例如 `otcclaw:v3.0.21-0706151315996`。默认只生成和推送这个对外版本 tag；如需兼容旧部署入口，可设置 `OTCCLAW_PUSH_ALIASES=1` 额外生成 `<version>` 和 `latest` 两个别名。需要只构建不启动时使用 `npm run docker:otcclaw:build`；清理 `<none>:<none>` dangling 镜像时使用 `npm run docker:otcclaw:prune`。`docker:samata:*` 脚本保留为内部兼容入口。

### 推送到 Code 平台制品库

OtcClaw 镜像发布脚本支持把同一套版本 tag 推送到 Code 平台制品库。制品库地址以 Code 平台项目页面展示为准，脚本不会在仓库中保存 registry 账号、密码或 token；发布前需要在本机先完成 Docker 登录，并刷新 SQLite 与 data files baseline。

```bash
docker login dockertest.gf.com.cn
npm run baseline:refresh
DOCKER_REPO=dockertest.gf.com.cn npm run docker:otcclaw:push
```

`docker:otcclaw:push` 会先确认 `docker-baseline/samata.db` 和 `docker-baseline/data-files.tar.gz` 存在，再执行一次镜像构建并推送对外版本 tag：

```text
dockertest.gf.com.cn/titans/otcclaw:v<version>-<MMddHHmmssSSS>
```

发布版本 tag 使用当前构建时间生成，不再依赖 Git sha 或 dirty 状态；如需固定发布 tag，可显式设置 `IMAGE_VERSION`。设置 `OTCCLAW_PUSH_ALIASES=1` 时，脚本会额外推送 `<version>` 和 `latest` 两个兼容 tag。脚本会拒绝向默认 `local` registry root 执行 push。

部署机需要拉取 Code 制品库镜像时，先渲染生产模板：

```bash
docker login dockertest.gf.com.cn
DOCKER_REPO=dockertest.gf.com.cn \
IMAGE_VERSION=v<version>-<MMddHHmmssSSS> \
bash scripts/deploy-otcclaw.sh deploy
```

统一部署脚本会一次拉取 OtcClaw 与 `otcclaw-langfuse-*` 镜像并启动，不需要再叠加独立 Langfuse Compose：

```bash
docker login dockertest.gf.com.cn
cp .env.example .env
cp .env.langfuse.example .env.langfuse
# 编辑 .env、.env.langfuse 和 /opt/samata/mcp-servers.json
IMAGE_VERSION=v<version>-<MMddHHmmssSSS> npm run docker:otcclaw:deploy
```

所有镜像统一使用 `DOCKER_REPO` 仓库根；OtcClaw tag 使用 `image_version`，Langfuse
各组件 tag 固定如下：

```text
dockertest.gf.com.cn/titans/otcclaw:<IMAGE_VERSION>
dockertest.gf.com.cn/titans/otcclaw-langfuse:3
dockertest.gf.com.cn/titans/otcclaw-langfuse-worker:3
dockertest.gf.com.cn/titans/otcclaw-langfuse-clickhouse-server:latest
dockertest.gf.com.cn/titans/otcclaw-langfuse-minio:latest
dockertest.gf.com.cn/titans/otcclaw-langfuse-redis:7
dockertest.gf.com.cn/titans/otcclaw-langfuse-postgres:16
```

容器内 Samata 监听 `0.0.0.0:3457`，宿主机可访问：

```bash
curl http://127.0.0.1:3457/health
CLI_SERVER_URL=http://127.0.0.1:3457 npm run cli
```

`docker-compose.local.yml` 才包含父目录 `..` build context，生产模板只引用镜像。`.env`、data、logs、SSH 和 `node_modules` 不会打进镜像；baseline 仍按原规则进入受控镜像。运行时只读挂载 `/opt/samata/mcp-servers.json` 和 `/opt/samata/ssh`，并挂载 `/opt/samata/data`、`/opt/samata/logs`。公共插件位于 `/app/plugins`，工作插件位于 `/app/work-plugins`。

首次准备部署目录时必须准备 MCP server 配置：

```bash
cp config/mcp-servers.example.json /opt/samata/mcp-servers.json
chmod 600 /opt/samata/mcp-servers.json
```

生产中的两个 LogYi MCP 实例保留各自的 `agents` 白名单和工具前缀，但共享同一套固定
base URL/username 以及一个部署参数 `LOGYI_API_KEY`。Compose 会把该 key 映射回当前
`mcp-servers.json` 引用的两组兼容变量：

```bash
LOGYI_API_KEY=...
```

镜像内会准备 sandbox 基础运行环境：Node.js 22、系统 Python 3、`python`/`python3`、pip、venv、bubblewrap 隔离工具，以及 sandbox 工具说明中声明的常用 Python 数据处理依赖（`psycopg2`、`pandas`、`numpy`、`matplotlib`、`openpyxl`、`xlrd`、`requests`、`beautifulsoup4`、`lxml`、`pillow`、`paramiko`、`cryptography`）。sandbox 代码会优先使用 `SANDBOX_PYTHON_BIN` 或 `SANDBOX_PYTHON_ROOT` 指定的 Python；容器中默认自动落到系统 Python。

Docker 默认权限通常不允许 bubblewrap 创建命名空间。Samata 会真实试跑 bubblewrap，只有可用时才启用文件系统隔离；不可用时自动退回普通执行，保证 Python/Node sandbox 任务能跑。若生产环境必须强隔离，需要单独评估并显式提高容器权限（例如 privileged 级别），不建议作为默认 compose 配置。

生产环境默认不提供 Chromium/Chrome DevTools 浏览器工具。`NODE_ENV=production` 时 Samata 会跳过 `devtools` MCP，不注册 `mcp_devtools_*`，并从 Agent prompt 中移除浏览器工具说明，避免在生产网络不可达时反复调用浏览器。特殊环境确实需要启用时可显式设置 `SAMATA_ENABLE_CHROMIUM_TOOLS=1`；开发环境需要禁用时可设置 `SAMATA_DISABLE_CHROMIUM_TOOLS=1`。

Fast Trading、Normal Trading、Hedge 和用户问题等插件业务表统一写入
`langfuse-postgres` 实例中的独立 `samata` 数据库，使用 `samata_app` 专用账号。
Langfuse Web/Worker 继续使用同一实例里的 `langfuse` 数据库，两者不共用数据库或账号。
Samata 核心用户、Agent、memory、knowledge 和 telemetry 本地记录仍写入
`/opt/samata/data/samata.db`；Langfuse trace 仍由 SDK 通过 HTTP 发给
`http://langfuse-web:3000`，不是 Samata 直写 Langfuse 数据库。

生产不再配置或访问 Wind PostgreSQL。生产模板中没有 `WIND_PG_*`、Wind reader、
Wind 检查服务或外部 Wind 网络；Agent 提示词、文件白名单和 sandbox 说明也不再提供
Wind 数据库查询入口。

`analyze_sbl_usage` 继续保留，但数据链路变为：

```text
SFTP borrow/trades CSV -> close_price 校验 -> SBL 数量/市值/使用率
```

SBL 插件直接使用 CSV 行内 `close_price`。价格为空、非法或非正数时保留对应数量、跳过
该行市值并返回缺价告警；本地旧缓存没有 `close_price` 表头时会自动重新下载。

历史 `wind_sync_pg/samata` 业务库迁移前先执行：

```bash
npm run postgres:migrate:dry-run
```

确认停写窗口后才执行：

```bash
bash scripts/migrate-samata-postgres.sh --execute
```

该脚本只读取旧容器中的 `samata` 数据库，不连接或校验其它数据库。停写窗口必须暂停所有
可能连接旧 `samata` 业务库的外部 cron、脚本和人工任务；脚本会在 dump 前后及替换目标
PostgreSQL 前检查活动连接和写入计数，发现 writer 重连或数据变化会在替换前中止。

dry-run 会校验生成 Compose 的 bind/guard/新卷约束、源库身份和版本、目标目录为空、
fresh Langfuse 卷状态及磁盘预算，不创建目录或卷。execute 会先拉取并 inspect 全部目标
镜像，持有可信 `/opt/samata` 目录 inode 的共享部署锁，并把已验证 Compose 复制到
权限为 `0600` 的临时快照。三个 fresh Langfuse 卷带本次迁移唯一 claim label；失败时
只删除仍属于本次且没有容器引用的未使用新卷。

恢复后脚本会比较逐表行数、catalog、约束、索引、序列和对象 owner，验证真实 PGDATA
bind 与 OtcClaw 只读 guard；fresh Langfuse 就绪后启动 OtcClaw，并等待 `/health` 成功。
启动失败会停止 OtcClaw，避免误连空库或半恢复库。源容器、源数据、dump 和旧 Langfuse
卷均保留；报告写入 `/opt/samata/backups/postgres-migration/<timestamp>/`。

截至 2026-07-21，现场已完成历史 `wind_sync_pg/samata` 到 fresh Langfuse PostgreSQL
`samata` 数据库的迁移，当前 PGDATA 绑定 `/opt/samata/data/postgres`。旧容器仅作为
保留的历史迁移源，不属于 Samata 运行时依赖；本次变更不会停止或删除该外部容器及数据。


生产宿主机需要配置企业 DNS，避免 Docker、Node.js、构建脚本和普通系统命令在解析内网域名时落到公网 DNS。推荐使用仓库脚本写入 `systemd-resolved` drop-in，并让 `/etc/resolv.conf` 优先走 `127.0.0.53`：

```bash
sudo bash scripts/configure-system-dns.sh apply
bash scripts/configure-system-dns.sh check
```

脚本会配置 `10.55.66.66`、`10.80.66.66` 作为系统 DNS，并保留 `8.8.8.8` 作为 fallback。需要回滚时执行：

```bash
sudo bash scripts/configure-system-dns.sh rollback
```

容器内访问内网 LLM 网关同样需要企业 DNS。compose 已为 Samata 配置 `10.55.66.66`、`10.80.66.66`，避免 Docker 默认 DNS 无法解析 `llm.smart-zone-dev.gf.com.cn`；系统级 DNS 生效后，宿主机和未显式覆盖 DNS 的运行进程也会使用同一解析入口。

Langfuse 六个服务已经合并进主生产模板。OtcClaw 容器内访问
`http://langfuse-web:3000`；Web 端口绑定 `0.0.0.0:3001`，宿主机浏览器访问
`http://127.0.0.1:3001`，受信网络访问 `http://<宿主机 IP>:3001`。生产环境应通过
主机防火墙或上游访问控制限制 `3001/tcp` 的来源网络。
`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` 同时用于首次初始化项目和 Samata SDK
写入，确保 trace 落入同一个 fresh 项目。`LANGFUSE_CAPTURE_CONTENT=true` 让新 trace
保存用户提问、模型回复和工具输入输出；`LANGFUSE_CAPTURE_SYSTEM_PROMPT=false` 继续
禁止上传 system prompt。启用正文采集前应确认数据分级、访问权限和保留策略，已有的
脱敏 trace 无法追溯恢复正文。PostgreSQL 使用
`/opt/samata/data/postgres`；ClickHouse/MinIO 使用
`otcclaw_prod_langfuse_*_v1` 新卷。旧 `samata_langfuse_*` 卷保留但不挂载，因此不继承
任何 Langfuse 历史。

生产 Compose 不包含 docs 服务。文档仅在源码目录通过 `npm run docs:dev` 启动。

生产模板固定
`SAMATA_DISABLED_TOOLS=generate_image,generate_video`，对应生产停用的生成能力。
`sync_sbl_data` 使用统一 SFTP 配置；`analyze_sbl_usage` 在此基础上通过专用只读账号查询
Wind 收盘价，两项均继续暴露。全局禁用策略在 Agent、用户、`all`、native、plugin、MCP
和定时任务决策之后执行，不能被局部配置重新加入。

文档站：

```bash
npm run docs:dev
```

局域网预览：

```bash
npm run docs:dev -- --host 0.0.0.0
```

## 模型配置

通过 `LLM_PROVIDER` 选择 provider，并配置对应 API key、base URL 和模型名。Custom、DeepSeek、Gemini、MiniMax、OpenRouter、Anthropic provider 走统一接口。

BigModel / GLM 图片识别使用 `custom` provider 的 OpenAI-compatible 接口：

```bash
LLM_PROVIDER=custom
CUSTOM_API_KEY=your-bigmodel-key
CUSTOM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
CUSTOM_MODEL=glm-5
CUSTOM_VISION_MODEL=glm-5v-turbo
CUSTOM_MODELS=glm-5,glm-5v-turbo
```

其中 `CUSTOM_VISION_MODEL` 用于图片消息、文档导入中的图片转录等识图场景。

如果购买的是 GLM-OCR 资源包，需额外启用 BigModel OCR。Samata 会在图片预处理和文档图片转录时优先调用 `glm-ocr` 的 `layout_parsing` 接口，失败后再回退到其他 vision provider：

```bash
BIGMODEL_API_KEY=your-bigmodel-key
BIGMODEL_OCR_BASE_URL=https://open.bigmodel.cn/api/paas/v4
BIGMODEL_OCR_MODEL=glm-ocr
BIGMODEL_OCR_ENABLED=true
```

`CUSTOM_VISION_MODEL=glm-5v-turbo` 走的是通用多模态聊天接口，不等同于 GLM-OCR 资源包。

## Agent 示例

Moss 这类轻量 Agent 的部署流程包括：创建 prompt、创建 Agent、配置成员、绑定 Bot 渠道。原始实施记录见 [Moss Agent 部署演进记录](../plan/2026-05-25_moss-deployment-guide.md)。
