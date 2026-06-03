# Codex Agent 图片生成与识别工具

## 背景

`samata-plugin-private` 已新增外部插件 `codex_agent`，用于把本机 Codex CLI 能力暴露给 Samata agent。第一期已实现 `generate_image_codex`，通过 Codex `$imagegen` 生成图片并保存到 `/tmp/samata/codex_agent`。

本次继续补齐图片识别能力，并要求 `generate_image_codex` 与图片识别工具对每一个 agent 可用。

## 本次改动

### samata-plugin-private

- `codex_agent` 插件新增 `recognize_image_codex` 工具。
- `recognize_image_codex` 支持：
  - `image_path`：单张图片本地路径
  - `image_paths`：多张图片本地路径
  - `prompt`：识别/分析要求
  - `detail`：`brief`、`normal`、`detailed`
  - `timeout_ms`：超时时间
- 图片识别通过 `codex exec --image <path>` 调用本机 Codex，默认使用 `read-only` sandbox。
- `codex_agent` 插件 scope 从 `agent-bound` 调整为 `universal`，方便 standard-mode agent 自动获得插件工具。
- 提取共享图片路径校验逻辑到 `codex_agent/src/files.ts`，供图片生成和图片识别复用。

### samata

- `codex_agent` 插件改为 `scope: "universal"` 后，Samata 的 standard-mode agent 会在 `getAgentTools()` 中自动合入 universal plugin tools。
- `all` mode agent 本身会看到全部 global tools，因此也会包含 `generate_image_codex` 与 `recognize_image_codex`。
- 通过工具枚举脚本确认当前数据库中的所有 agent 都能看到上述两个工具。

## 验证

- `samata-plugin-private`: `npm test`，24 tests passed。
- `samata-plugin-private`: `npm run build --workspaces --if-present`，通过。
- `samata`: `npx vitest run tests/unit/schema/schema.test.ts`，32 tests passed。
- `samata`: agent 工具枚举确认 `alter-ego`、`tutor`、`admin`、`falcon`、`potato`、`doctor`、`man` 都包含 `generate_image_codex` 与 `recognize_image_codex`。

## 后续约定

- 每次代码改动需要同步生成/更新一份 `docs/plan` 留档，记录背景、改动范围、验证方式和注意事项。
- 若会话中有可用记忆写入工具，应把该约定写入记忆。
- 当前 Codex 会话没有暴露可写记忆工具，因此本约定先以本文档形式留档；后续若记忆工具可用，再补写到记忆中。
