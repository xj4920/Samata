---
docModules:
  - platform
docTopics:
  platform: 工程规范
canonicalDocs:
  - /platform/architecture
status: implemented
---

# 变更留档、提交与推送规范

## 背景

项目维护过程中需要让每次代码或文档修改都有可追溯记录，避免只在对话中说明、但仓库里缺少设计和验收上下文。用户明确要求：每次修改后提交代码并 push，详细说明修改点，并写入编码规则。

## 决策

- 将规则写入 `CLAUDE.md` 的「项目结构规范」章节，作为后续编码与协作的长期约束。
- 每次代码或文档变更完成后，必须同步新增或更新 `docs/plan/YYYY-MM-DD_<topic>.md`。
- plan 内容应覆盖背景、决策、改动清单、验证命令和提交信息。
- 完成验证后必须提交并 `git push` 到远端。
- 最终回复必须包含详细修改点、验证结果、commit hash 和 push 信息。
- 长期有效规则或关键决策还需要写入 memory。

## 改动清单

- 更新 `CLAUDE.md`：
  - 新增“每次修改后必须留档、提交并推送”规则。
  - 明确 docs/plan、commit、push、最终回复说明要求。
- 新增本 plan 文档。
- 同步 VitePress plan 索引。
- 写入全局 memory，确保后续会话也能遵循该规则。
- 同步提交本轮未入库的工程收尾：
  - `Dockerfile`：调整 `COPY samata ./` 到插件依赖安装之后，减少主仓文件复制对插件层缓存的影响。
  - `src/commands/monitor.ts`：读取 git hash 时忽略 stderr，避免非 git 环境或容器运行时输出无关错误。

## 验证

- `npm run docs:plan-sync`
- 检查 `docs/.vitepress/plan-index.generated.ts` 包含本 plan。
- `npx tsc --noEmit`
- `docker compose config --quiet`

## 后续执行方式

后续每个改动任务结束前，按顺序执行：

1. 更新或新增 `docs/plan/YYYY-MM-DD_<topic>.md`。
2. 将长期规则或关键决策写入 memory。
3. 运行与改动范围匹配的验证命令。
4. `git add` 相关文件。
5. `git commit -m "<message>"`。
6. `git push`。
7. 最终回复详细说明修改点、验证、commit 和 push 状态。
