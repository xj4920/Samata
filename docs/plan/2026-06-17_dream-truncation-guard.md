---
docModules:
  - dream
docTopics:
  dream: 质量与观测
canonicalDocs:
  - /dream/quality
status: implemented
---

# Dream 截断保护增强

## 背景

2026-06-17 03:00 处理 2026-06-16 Dream 时，`ticlaw` 生成结果被质量保护判定为 `疑似截断结尾`，因此跳过写入并继续使用上一份有效 Dream。排查确认旧逻辑主要依赖输出末尾字符是否像完整句子，缺少模型 stop reason、结构完整性和重试机制，误判与漏判空间都较大。

已使用 harness 在 Code 平台创建 issue：`https://code.gf.com.cn/gf/_code/gf/gzxujun/samata/-/issues/27`。

## 决策

- 新生成的 Dream 必须以 `<!-- DREAM_COMPLETE -->` 作为最后一行，写入前校验，落盘前剥离。
- `stop_reason=max_tokens` / OpenAI 兼容接口 `finish_reason=length` 视为强截断信号。
- 新生成内容启用更严格的 Markdown 结构校验；历史 Dream 读取保持兼容，不强制完成标记。
- 截断类质量失败自动重试一次，重试时提高 token 上限并要求压缩历史经验、完整输出。
- 日志保留具体失败原因，区分缺少完成标记、代码块未闭合、token 上限等情况。

## 改动清单

- `src/services/dream-analyze.ts`
  - 新增 Dream 完成标记、token 上限 stop reason、Markdown 结构完整性校验。
  - `runDreamForAgent()` 对截断类失败自动重试一次，成功后写入剥离完成标记的内容。
  - 读取历史 Dream 时不要求完成标记，避免误伤存量有效经验。
- `src/llm/openai-compat.ts`
  - 将 OpenAI 兼容响应 `finish_reason=length` 映射为统一的 `stop_reason=max_tokens`。
- `tests/unit/services/dream-analyze.test.ts`
  - 覆盖完成标记、未闭合代码块、截断重试成功写入。
- `tests/unit/llm/openai-compat.test.ts`
  - 覆盖 `length -> max_tokens` 映射。

## 验证命令

- 已执行：`git pull --ff-only`，结果为“已经是最新的”。
- 已执行：`npm test -- tests/unit/services/dream-analyze.test.ts tests/unit/services/dream-scheduler.test.ts tests/unit/llm/openai-compat.test.ts`，3 个测试文件、8 个测试通过。
- 已执行：`npx tsc --noEmit`，通过。
- 已执行：`node --import tsx/esm - <<'NODE' ... validateDream/loadDreamFile ... NODE`，确认历史文件读取仍不强制完成标记，`otcclaw`、`ticlaw`、`admin` 均能加载最新有效 Dream。

## 构建与发布

- 本次改动只涉及 TypeScript 运行逻辑、单元测试和文档留档，不涉及数据库迁移。
- 若生产环境需要立即生效，需要重新构建并重启 `samata` 容器；当前尚未执行构建或重启。

## Commit Hash

- 实现提交：`99cdf3b5e9387bd155060e1de24fd88cb46f2a88`
