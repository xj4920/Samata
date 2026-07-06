---
docModules:
  - platform
docTopics:
  platform: 部署与运行
canonicalDocs:
  - /platform/deployment
status: implemented
---

# OtcClaw Docker 镜像版本格式对齐

## 背景

Code 制品库版本列表以 `v1.69.1-0630165158`、`v1.69.53-0706151315996` 这类格式展示镜像版本。OtcClaw 之前默认使用 `package.version + git sha + dirty timestamp` 作为主 tag，并同时推送 `<version>` 与 `latest`，与制品库展示习惯不一致。

## 决策

1. OtcClaw 对外 Docker 主 tag 改为 `v<package.version>-<MMddHHmmssSSS>`，例如 `v3.0.20-0706151315996`。
2. 默认 push 只推送对外版本 tag，避免制品库版本列表混入 `latest` 或裸版本号。
3. 继续支持 `OTCCLAW_IMAGE_TAG` / `SAMATA_IMAGE_TAG` 固定指定 tag。
4. 如需兼容旧部署入口，可显式设置 `OTCCLAW_PUSH_ALIASES=1` 或 `SAMATA_PUSH_ALIASES=1`，额外推送 `<version>` 与 `latest`。
5. 版本按项目规则从 `3.0.19` 递增到 `3.0.20`，并同步 `package-lock.json`。

## 改动清单

- `scripts/docker-samata.sh`
  - 默认 tag 生成逻辑改为 `v<version>-<MMddHHmmssSSS>`。
  - 移除默认 Git sha / dirty suffix 参与 tag 的逻辑。
  - 默认只推送主 tag；新增 `OTCCLAW_PUSH_ALIASES` / `SAMATA_PUSH_ALIASES` 控制兼容 tag。
- `README.md`
  - 补充 OtcClaw push 默认版本格式和兼容别名开关说明。
- `docs/platform/deployment.md`
  - 更新构建、推送、拉取部署示例，统一使用 `v<version>-<MMddHHmmssSSS>`。
- `package.json` / `package-lock.json`
  - 版本递增到 `3.0.20`。

## 验证命令

```bash
bash -n scripts/docker-samata.sh
docker compose --env-file /dev/null config --quiet
npm run docs:plan-sync
npm run docker:otcclaw:build
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^otcclaw:v3.0.20-'
```

## 验证结果

- `bash -n scripts/docker-samata.sh`：通过。
- `docker compose --env-file /dev/null config --quiet`：通过。
- `npm run docs:plan-sync`：退出码 0，已更新 `docs/.vitepress/plan-index.generated.ts`；命令仍打印历史 plan frontmatter 告警/错误，和本次新增 plan 无关。
- `npm run docker:otcclaw:build`：通过，生成本地镜像 `otcclaw:v3.0.20-0706154642226`，image id 为 `sha256:b365e266faba168350404ba3ba6fdf385f66d1c362c2dcda2aee076a99dbfbf2`。
- `docker image inspect otcclaw:3.0.20`：未找到，确认默认未生成裸版本兼容 tag。
- `docker image inspect otcclaw:v3.0.20-0706154642226`：通过，确认主 tag 可解析。

## Commit

- 待提交后回填。
