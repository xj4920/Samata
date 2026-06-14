---
docModules:
  - platform
docTopics:
  platform: 运行观测与告警降噪
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Samata 日志观测与告警降噪优化

## 背景

2026-06-14 的 Samata 日志检查报告为 warning：`errors=32`、`timeouts=3`、`slow_steps=22`、`permission_errors=12`、`auth_model_failures=3`、`source_not_found=14`，并提示缺少 `logs/daily_usage/2026-06-14_telemetry_wework.md`。进一步排查后确认：

- 当日 17:45 检查早于 23:30/23:35 的每日 usage cron，因此当天 `daily_usage` 文件未生成属于调度未到点，不应直接作为缺失源告警。
- `cron_analyze.log` 中反复出现 `未找到用户提问记录 (渠道: feishu)`，本质是渠道无数据，但容易被外部检查归为 `source_not_found`。
- `app-2026-06-14.log` 中存在 `ripgrep search failed: spawnSync rg ENOBUFS`，说明知识检索输出未充分限流。
- workspace summary 使用 `custom/claude-opus-4-6-20260205` 后 fallback 到 `custom/external-deepseek-v4-pro` 仍报 403；用户确认 summary 模型改为 DS V4 Pro。
- Docker 日志显示 `wiki-sync` 在每日同步时因单页 HTML/DOM 转换异常中断，导致 598 个待导出页仅处理 25 个左右，snapshot 未推进。
- 当前 Samata 容器主进程以 root 运行，`logs` 与部分运行时文件被 root 写入，后续分析或宿主机工具可能遇到权限噪声。

已使用 harness 在 Code 平台创建 issue：`https://code.gf.com.cn/gf/_code/gf/gzxujun/samata/-/issues/22`。

## 决策

- `analyze-log` 对已分析但无会话的渠道输出显式 `no_data` Markdown 报告，避免“无数据”与“源不存在”混淆。
- `ripgrep` 搜索统一加大 buffer、限制单文件大小、减少上下文行，并在 `ENOBUFS` 时降级为无上下文小结果重试。
- Docker 生产环境通过 compose 环境变量覆盖 summary provider/model：`PROVIDER_SUMMARY=custom`、`MODEL_SUMMARY=external-deepseek-v4-pro`，不修改含密钥的 `.env`。
- 容器启动入口先修正 bind mount 的 `data/logs` 权限，再用 `gosu node` 降权运行 Samata 主进程。
- `wiki-sync` 插件的单页导出失败由插件仓单独处理并留档；主仓只记录 Docker 镜像会纳入该插件变更。

## 改动清单

- `scripts/analyze-log.ts`
  - 新增 no-data 报告模板。
  - 渠道过滤后没有会话时仍写入 `logs/daily_usage/<date>_telemetry_<channel>.md`，状态标为 `no_data`。
- `src/utils/grep-search.ts`
  - 新增 ripgrep 参数构造与 JSON 解析 helper。
  - 增加 `RG_MAX_BUFFER_BYTES`、`RG_TIMEOUT_MS`、`RG_MAX_FILESIZE` 可配置项。
  - `ENOBUFS` 时自动降级为更小结果集重试。
- `.env.example`
  - 补充 Summary/工作区摘要 DS V4 Pro 配置样例。
- `docker-compose.yml`
  - 为 `samata` 服务设置 summary provider/model 覆盖值。
- `Dockerfile`
  - 安装 `gosu`。
  - 设置 Docker entrypoint 并调整镜像内目录归属。
- `scripts/docker-entrypoint.sh`
  - 启动时修正 `/app/samata/data` 与 `/app/samata/logs` 权限。
  - 降权到 `node` 用户执行 Samata。
- `docs/plan/2026-06-14_samata-log-observability-optimization.md`
  - 记录本次背景、决策、改动、验证与发布状态。

## 验证命令

- 已执行：`git pull --ff-only`，因 Code 平台 SSH 配置仍指向旧 IP，使用临时 `GIT_SSH_COMMAND` 指定 `HostName=10.80.79.167` 后成功，结果为“已经是最新的”。
- 已执行：`npm run analyze-log -- --source=telemetry --channel=feishu --from=2026-06-14 --to=2026-06-14`，生成 `logs/daily_usage/2026-06-14_telemetry_feishu.md`，状态为 `no_data`。
- 已执行：`npx tsc --noEmit`。
- 已执行：`npm run build -w wiki-sync`（插件仓）。
- 已执行：`git diff --check && git -C ../samata-plugin-work diff --check`。
- 已执行：`npm run docs:plan-sync`，成功更新 `docs/.vitepress/plan-index.generated.ts`；输出仍包含历史 plan 缺少 `docModules` 的既有提示，本次新增文件未被点名。
- 已执行：`npm run docker:samata:build`，成功生成 `samata:3.0.13-5e6bbe97390a-dirty-20260614200731`，并刷新 `samata:3.0.13` 与 `samata:latest`。
- 已执行：`docker run --rm samata:latest node -e "console.log(process.getuid(), process.getgid())"`，输出 `1000 1000`，确认 entrypoint 降权到 `node` 用户。
- 已执行：`docker compose --env-file /dev/null config | rg -n "PROVIDER_SUMMARY|MODEL_SUMMARY|image:"`，确认 compose 环境包含 `PROVIDER_SUMMARY=custom` 与 `MODEL_SUMMARY=external-deepseek-v4-pro`。

## 构建与发布

- 本次改动影响 Dockerfile、docker-compose 环境、运行时 entrypoint 和工作插件源码，已重建 Samata image。
- 改动不涉及数据库迁移，不写入 `data/samata.db` 或 memory 表。
- 当前仅完成 image build 和 smoke check，未重启正在运行的 `samata` 容器；等待用户确认提交与部署后再重启服务。
- 编码验证完成后需等待用户确认，再执行 `git add`、`git commit`、`git push`。
- 主仓如向 `origin` 推送，必须同时向 `github` 推送同一分支。

## Commit Hash

- 实现提交：待提交后回填。
