---
docModules:
  - platform
docTopics:
  platform: 知识检索限流与告警修复
canonicalDocs:
  - /platform/common-tools
status: implemented
---

# Ripgrep 知识检索 Buffer 溢出修复

## 背景

2026-06-17 最新容器日志仍出现：

- `ripgrep search failed: output exceeded 41943040 bytes, retrying with reduced context`
- `ripgrep search failed fallback failed: spawnSync rg ENOBUFS`

排查确认该日志由 `search_knowledge` 的文档检索触发，直接来源是 `src/utils/grep-search.ts`，不是后续调用成功的 `titans_code_grep`。容器内复现同类查询 `TRS 合约 修改 重跑 生命周期估值` 时，默认 `rg --json` 输出约 136MB，fallback 输出仍约 79.6MB，均超过 40MB buffer；`ticlaw` 文档库已有 10845 个 `parsed.md`，宽关键词会把“每文件限流”放大成全局大输出。

## 决策

- 不再让 `rg --json` 输出所有 match/context 记录；`rg` 只使用 `--files-with-matches` 返回候选文件列表。
- 候选文件的逐行匹配、frontmatter 解析、分区评分和 snippet 组装统一在 Node 进程内完成，复用现有 `FileState -> scoreFile -> buildSnippet` 数据流。
- 如果 `rg` 不可用、超时或候选文件列表异常，降级为已有 Node 全量扫描路径，保证检索可用性优先。
- 不修改 Samata 运行时 memory 数据库，不写入 `data/samata.db` 的 `memory` 表。

## 改动清单

- `src/utils/grep-search.ts`
  - 移除文档/wiki 检索中的 `rg --json` 全量输出与二次 fallback JSON 输出路径。
  - 新增候选文件列表扫描：`rg -F -i --files-with-matches --max-filesize ...`。
  - 新增通用 Markdown 文件扫描与评分 helper，文档检索和 wiki 检索共用。
  - 保留 `rg` 不可用或失败时的 Node 扫描兜底。

## 验证命令

- 已执行：`git pull --ff-only`；首次远端临时返回 `resource temporarily unavailable`，重试后成功，结果为“已经是最新的”。
- 已执行：`npx tsc --noEmit`。
- 已执行：`npx tsx -e "import { grepSearchDocuments } from './src/utils/grep-search.ts'; ..."`，使用 `TRS 合约 修改 重跑 生命周期估值` 对 `ticlaw` 文档检索复现，2.098s 返回 5 条文档结果，未触发 ENOBUFS。
- 已执行：`npm run docs:plan-sync`，成功更新 `docs/.vitepress/plan-index.generated.ts`；输出仍包含历史 plan 缺少 `docModules` 的既有提示，本次新增文件未被点名。
- 已执行：`git diff --check`。
- 已执行：`npm run docker:samata:build`，成功生成 `samata:3.0.13-1efeb8ff1d36-dirty-20260617151211`，并刷新 `samata:3.0.13` 与 `samata:latest`。
- 已执行：`docker run --rm samata:latest sh -lc "rg -n -- '--files-with-matches|runRipgrepJson|RG_OUTPUT_LIMIT' ..."`，确认新知识检索代码已进入镜像。

## 构建与发布

- 本次改动影响 Samata 运行时知识检索逻辑，已重建 Samata Docker image；尚未重启正在运行的 `samata` 容器。
- 不涉及依赖变更或数据库迁移。
- 当前已完成源码修改、类型检查、复现实测、文档索引同步、镜像构建与镜像内容 smoke check，尚未提交、推送或重启容器。

## Commit Hash

- 实现提交：`0337e28dcc9c89ee822418ecff1d633c8fbc28c9`
