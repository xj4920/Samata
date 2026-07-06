---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# OtcClaw Docker 发布与 SQLite Baseline 初始化

## 背景

Samata 内部项目需要以 OtcClaw 名称对外发布到公司 Docker tst/生产制品库，并希望测试环境只拉取 OtcClaw 主镜像即可启动基础服务。同时，目标镜像需要内置当前运行库作为首次启动 baseline，避免新环境只有空白 `admin` 基线。

## 决策

1. 对外 Docker image、Compose service 和 container 使用 `otcclaw`；内部源码目录、`/app/samata`、`data/samata.db` 和 `SAMATA_*` 兼容变量保持不变。
2. SQLite baseline 使用当前 `/opt/samata/data/samata.db` 的一致性备份，生成到本地忽略目录 `docker-baseline/samata.db`，只进入 Docker build context，不提交到 Git。
3. Entrypoint 仅在运行目录没有 `samata.db` 且镜像内存在 baseline 时复制；已有数据库永不覆盖。
4. OtcClaw 主镜像不打包 PG 或 Langfuse。Wind/FastTrading/Log 的 Postgres 连接通过可选 `docker-compose.wind-sync.yml` 叠加；Langfuse 继续使用独立 compose。
5. `docker:otcclaw:push` 在推送前强制检查 baseline 文件，避免发布缺少初始 SQLite 的制品。

## 改动清单

- `docker-compose.yml`
  - 主服务改为 `otcclaw`，容器名改为 `otcclaw`，默认镜像名改为 `otcclaw`。
  - docs 容器名改为 `otcclaw-docs`。
- `docker-compose.wind-sync.yml`
  - 新增可选 Postgres 网络与环境变量覆盖。
- `scripts/docker-samata.sh`
  - 支持 `OTCCLAW_IMAGE_REPO` / `OTCCLAW_IMAGE_TAG`，保留 `SAMATA_IMAGE_REPO` / `SAMATA_IMAGE_TAG`。
  - 默认构建 `otcclaw` service，推送前检查 `docker-baseline/samata.db`。
- `scripts/prepare-sqlite-baseline.ts`
  - 新增 SQLite backup 生成脚本，默认从 `/opt/samata/data/samata.db` 输出到 `docker-baseline/samata.db`。
- `scripts/docker-entrypoint.sh`
  - 首次启动空数据目录时从镜像内 baseline 初始化 SQLite。
- `Dockerfile` / `Dockerfile.dockerignore`
  - OCI title 改为 `OtcClaw`。
  - 保留 baseline DB 进入镜像，排除 baseline WAL/SHM。
- `package.json` / `package-lock.json`
  - 版本递增到 `3.0.19`。
  - 新增 `sqlite:baseline:refresh` 与 `docker:otcclaw:*` 脚本。
- `README.md` / `docs/platform/deployment.md`
  - 更新 OtcClaw 发布、baseline、PG/Langfuse 外部依赖说明。

## 验证命令

```bash
bash -n scripts/docker-samata.sh
sh -n scripts/docker-entrypoint.sh
npm run sqlite:baseline:refresh
test -s docker-baseline/samata.db
git check-ignore -v docker-baseline/samata.db
docker compose --env-file /dev/null config --quiet
docker compose --env-file /dev/null config --services
docker compose --env-file /dev/null -f docker-compose.yml -f docker-compose.wind-sync.yml config --quiet
npm run docker:otcclaw:build
```

结果：

- `bash -n scripts/docker-samata.sh`：通过。
- `sh -n scripts/docker-entrypoint.sh`：通过。
- `npm run sqlite:baseline:refresh`：通过，生成 `docker-baseline/samata.db`，大小 `31166464` bytes。
- `test -s docker-baseline/samata.db`：通过。
- `git check-ignore -v docker-baseline/samata.db`：通过，确认 baseline DB 被 `.gitignore` 忽略。
- `docker compose --env-file /dev/null config --quiet`：通过。
- `docker compose --env-file /dev/null config --services`：输出 `otcclaw`。
- `docker compose --env-file /dev/null -f docker-compose.yml -f docker-compose.wind-sync.yml config --quiet`：通过。
- `npm run docs:plan-sync`：退出码 0，刷新 `docs/.vitepress/plan-index.generated.ts`；仍输出历史 plan 缺 frontmatter 或 canonicalDocs 指向缺失的既有提示。
- `npm run docker:otcclaw:build`：通过，生成本地镜像 `otcclaw:3.0.19` / `otcclaw:latest`，image id 为 `sha256:e635e46a59c9bb74997d358d6c603d11cf09d2861999f540af42be1c0d32bf0f`。
- 镜像检查：`/app/samata/docker-baseline/samata.db` 存在且大小为 `31166464` bytes，OCI title 为 `OtcClaw`。
- 临时空数据目录容器验证：通过，容器 health 为 `healthy`，首次启动复制出的 SQLite 中 `agents` 数量为 `8`。
- 默认本地镜像名 push 保护：通过，未设置远端仓库时拒绝推送。
- `git diff --check`：通过。

- `OTCCLAW_IMAGE_REPO=dockertest.gf.com.cn/gf/libra/otcclaw npm run docker:otcclaw:push`：已执行构建并开始推送，生成待推送 tag `3.0.19-e6fe0b103710-dirty-20260706152825`，但 registry 返回 `unauthorized: The client does not have permission to push to the repository.`；当前 Docker 登录账号没有向 `dockertest.gf.com.cn/gf/libra/otcclaw` 创建或推送仓库的权限。
- `OTCCLAW_IMAGE_REPO=dockertest.gf.com.cn/titans/otcclaw npm run docker:otcclaw:push`：通过，已推送以下 tst tag，digest 均为 `sha256:bfdc25e5b237bc910315f07b3e4922928d573e468b7b512243ed19d8e804fbab`：
  - `dockertest.gf.com.cn/titans/otcclaw:3.0.19-e6fe0b103710-dirty-20260706153124`
  - `dockertest.gf.com.cn/titans/otcclaw:3.0.19`
  - `dockertest.gf.com.cn/titans/otcclaw:latest`

## 构建与运行影响

本次改动影响 Docker image、Compose service/container 命名、镜像 tag、启动时 SQLite 初始化逻辑和 package version。发布到 tst 或生产需要重新构建并推送 `otcclaw` 镜像；部署时需要停止旧 `samata` 容器或避免 3457 端口冲突。PG 与 Langfuse 不随主镜像打包，按环境需要单独准备。

## Commit Hash

- 待提交后回填。
