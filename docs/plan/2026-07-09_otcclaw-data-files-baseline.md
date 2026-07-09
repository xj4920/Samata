---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# OtcClaw Data Files Baseline

## 背景

OtcClaw 镜像已有 SQLite baseline，会把当前运行库打入 `/app/samata/docker-baseline/samata.db`，用于全新部署目录首次启动。但 agent 运行时文件数据不在 SQLite 内，尤其是：

- `data/documents/`
- `data/wiki/`
- `data/plugins/`
- `data/dreams/`

这些目录被 Docker 构建上下文排除，不会随镜像发布。只刷新 SQLite baseline 时，全新环境可能出现 DB 元数据存在但文件内容缺失，导致文档、wiki、插件数据或 dream 经验不完整。

## 决策

新增 data files baseline，默认从 `/opt/samata/data` 抽取 `documents/`、`wiki/`、`plugins/`、`dreams/`，生成 `docker-baseline/data-files.tar.gz` 和 `docker-baseline/data-files.manifest.json`。镜像首次启动时仅在 SQLite baseline 被复制为初始主库的同一次启动中解压文件 baseline；已有运行库不覆盖。

插件目录中可能存在独立 SQLite。生成归档前先创建 staging 快照，遇到 `*.db` / `*.sqlite` / `*.sqlite3` 文件时优先通过 SQLite backup API 生成一致性副本，并跳过 `*.db-wal` / `*.db-shm` 边车文件。

## 改动清单

- `scripts/prepare-data-files-baseline.ts`
  - 新增 data files baseline 生成脚本。
  - 生成 tar.gz 与 manifest，记录 include、大小、SHA-256、SQLite backup 与跳过项。
- `scripts/docker-entrypoint.sh`
  - 在首次复制 SQLite baseline 后解压 `data-files.tar.gz`。
  - 写入 `data/.samata-data-baseline-restored` marker。
- `scripts/docker-samata.sh`
  - `push` 前检查 `docker-baseline/data-files.tar.gz`。
  - 新增 `OTCCLAW_DATA_FILES_BASELINE` 覆盖变量说明。
- `package.json`
  - 新增 `data:baseline:refresh` 与 `baseline:refresh`。
- `README.md`
  - 更新镜像发布命令与 baseline 说明。
- `docs/platform/deployment.md`
  - 更新首次恢复语义、发布命令、构建上下文说明。

## 验证命令

```bash
npm run baseline:refresh
tar -tzf docker-baseline/data-files.tar.gz | sed -n '1,80p'
node -e "const m=require('./docker-baseline/data-files.manifest.json'); console.log(m.archive); console.log(m.include)"
npm run docker:otcclaw:build
docker run --rm --entrypoint sh otcclaw:<tag> -c 'ls -lh /app/samata/docker-baseline && tar -tzf /app/samata/docker-baseline/data-files.tar.gz | sed -n "1,40p"'
docker run --rm -v <empty-data-dir>:/app/samata/data --entrypoint sh otcclaw:<tag> -c 'scripts/docker-entrypoint.sh sh -c "test -f /app/samata/data/samata.db && test -f /app/samata/data/.samata-data-baseline-restored && ls /app/samata/data"'
git diff --check
git status --short
```

## 验证结果

- `npm run baseline:refresh`：通过。
  - SQLite baseline：`docker-baseline/samata.db`，大小 `31166464` bytes，SHA-256 为 `67d7fdcb930318abd5c52a80f4e681f2f2f70f468a870fd6c5c0d4928e72a885`。
  - Data files baseline：`docker-baseline/data-files.tar.gz`，大小 `1492445081` bytes，SHA-256 为 `89504ebc078d2853deefdce47376b6951489ee1c5a63f302299202d89fb699d1`。
  - Manifest 统计：目录 `21028` 个，文件 `99789` 个，普通复制文件 `99780` 个，SQLite backup `9` 个，SQLite fallback copy `0` 个，跳过 sidecar `18` 个，跳过 symlink `0` 个。
- 归档范围检查：`tar -tzf docker-baseline/data-files.tar.gz` 只包含目标目录；未发现 `workspaces`、`backups`、`logs`、`samata.db`、导入状态等非目标路径。
- `git check-ignore -v docker-baseline/data-files.tar.gz docker-baseline/data-files.manifest.json docker-baseline/samata.db`：通过，确认 baseline 产物被忽略。
- `npm run docker:otcclaw:build`：通过，生成镜像 `otcclaw:v3.0.29-0709165206163`，image id 为 `sha256:a3cdac82e2c8d9a854bbebeb2b2541ff69389a47bf5618f2034170ff6a56ddcd`，image size 为 `6290312675` bytes。
- 镜像内 baseline 校验：`/app/samata/docker-baseline/samata.db` 与 `/app/samata/docker-baseline/data-files.tar.gz` 存在，SHA-256 与本地 baseline 一致。
- 空 data 目录首次启动模拟：通过，恢复出 `samata.db`、`documents/`、`wiki/`、`plugins/`、`dreams/` 与 `.samata-data-baseline-restored`，恢复后临时目录约 `3.8G`。
- 已有 `samata.db` 的 data 目录保护模拟：通过，未解压 data files baseline，未写入 restore marker。
- `sh -n scripts/docker-entrypoint.sh`：通过。
- `bash -n scripts/docker-samata.sh`：通过。
- `git diff --check`：通过。

## 构建与重启影响

本次改动影响 Docker image 构建内容和容器首次启动初始化逻辑。需要重新生成 SQLite 与 data files baseline，并重新构建 OtcClaw 镜像。部署已有 `/opt/samata/data/samata.db` 的环境时，更新镜像不会覆盖现有 SQLite 或文件数据；只有全新 data 目录首次启动会恢复 baseline。

## Commit

待提交。
