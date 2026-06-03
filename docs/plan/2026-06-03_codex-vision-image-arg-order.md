# Codex Vision Image Argument Order Fix

## Summary

`recognize_image_codex` 调用失败，日志显示 `Codex 图片识别失败 (exit=1)`，stderr 为 `Reading prompt from stdin... No prompt provided via stdin.`。工具入参中已经包含正确的本地图片路径，说明失败不在路径解析，而在 Codex CLI 参数组装。

## Root Cause

- Codex CLI 的 `--image <FILE>...` 是可变长参数。
- 当前 `buildCodexExecArgs()` 先追加 `--image <path>`，最后再追加 prompt。
- 当 prompt 放在 `--image` 后面时，Codex CLI 会把 prompt 当作另一个 image 参数吞掉。
- 结果就是没有 positional prompt，Codex 转而从 stdin 读取 prompt；stdin 关闭后报 `No prompt provided via stdin`。

## Key Changes

- 调整 `codex_agent/src/codex.ts` 参数顺序：先放 prompt，再追加 `--image <path>`。
- 更新 `codex_agent/tests/codex_agent.test.ts`，断言 prompt 位于 `--image` 之前，避免回归。

## Validation Plan

- 真实 CLI 验证：
  - `codex exec ... --image <img> "prompt"` 复现失败。
  - `codex exec ... "prompt" --image <img>` 成功返回。
- `samata-plugin-private`: 运行 `npm test`。
- `samata-plugin-private`: 运行 `npm run build --workspaces --if-present`。
- 使用 `recognize_image_codex` 对本地测试图片实际识别，确认返回 `success: true`。
- 重启 Samata，确认 `codex_agent` 仍加载 2 个工具。

## Memory Note

继续遵循用户约定：每次代码改动都写入 `docs/plan` 留档；当前会话没有长期记忆写入工具，因此以计划文档记录。
