---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Code 平台制品库 Docker 推送

## 背景

Samata 已支持通过 Docker Compose 构建本地镜像，并根据 `package.json` 版本号和 git short sha 生成可追溯 tag。但发布到公司 Code 平台制品库时，缺少统一的 npm/script 入口和部署文档说明，容易依赖人工执行 `docker tag` / `docker push`。

## 决策

1. 复用现有 `scripts/docker-samata.sh` 的镜像版本生成逻辑，不新增独立构建路径。
2. 新增 `push` 命令，在同一次流程中构建、补齐别名 tag 并推送：
   - `<repo>:<version>-<git-sha>`
   - `<repo>:<version>`
   - `<repo>:latest`
3. 推送时必须显式设置 `SAMATA_IMAGE_REPO`，避免默认 `samata` 镜像名被误推到公共 registry。
4. Code 平台 registry 地址、账号、密码或 token 不写入仓库，由发布机通过 `docker login <code-registry-host>` 预先配置。
5. 部署文档使用 `<code-registry-host>/<namespace>/samata` 占位，实际路径以 Code 平台项目制品库页面为准。

## 改动清单

- `scripts/docker-samata.sh`
  - 支持 `push` 命令。
  - 增加远端镜像仓库必填保护。
  - 推送主 tag、版本 tag 和 `latest` tag。
- `package.json`
  - 新增 `docker:samata:push` npm 脚本。
- `docs/platform/deployment.md`
  - 新增推送到 Code 平台制品库的发布和部署说明。
- `docs/plan/2026-06-23_code-artifact-docker-push.md`
  - 记录本次发布流程改造。

## 验证命令

```bash
bash -n scripts/docker-samata.sh
docker compose --env-file /dev/null config --quiet
npm run docs:plan-sync
```

结果：

- `bash -n scripts/docker-samata.sh`：通过。
- `docker compose --env-file /dev/null config --quiet`：通过。
- `bash scripts/docker-samata.sh --help`：输出包含 `push` 命令和 Code registry 示例。
- `bash scripts/docker-samata.sh push`：在未设置 `SAMATA_IMAGE_REPO` 时按预期拒绝推送默认本地镜像名。
- `npm run docs:plan-sync`：退出码 0，并更新 `docs/.vitepress/plan-index.generated.ts`；输出中仍有若干历史 plan 缺 `docModules` 的既有提示，本次新增 plan frontmatter 已被索引。

## 构建与运行影响

本次改动影响 Docker 镜像发布脚本和部署文档，不改变 Samata 运行时代码、Dockerfile 内容、依赖或数据库迁移。应用运行时不需要因本次改动重启；实际向 Code 平台制品库发布时，需要执行 `npm run docker:samata:push` 重新构建并推送镜像。

## Commit Hash

待提交。
