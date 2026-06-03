# Codex Image Generation Stdin Fix

## Summary

`generate_image_codex` 工具已经被 agent 加载并实际调用，但运行日志显示 Codex 子进程在 180 秒后超时，stderr 为 `Reading additional input from stdin...`。这说明 `codex exec` 收到 prompt 后仍在等待 stdin 结束，导致 `$imagegen` 没有真正进入执行阶段。

## Root Cause

- `codex_agent/src/codex.ts` 使用 `spawn('codex', args)` 调用 Codex CLI。
- Node `spawn` 默认会为 stdin 创建管道。
- Codex CLI 文档说明：如果 prompt 已作为参数传入，同时 stdin 是 pipe，则会继续读取 stdin 并追加为 `<stdin>` block。
- 插件没有关闭 child stdin，Codex 一直等待 EOF，最终被 timeout 杀掉。

## Key Changes

- `runCodexExec()` 在 spawn 后立即执行 `child.stdin?.end()`。
- 单测 mock spawn 增加 stdin stream，并断言 `runCodexExec()` 会关闭 stdin。

## Validation Plan

- `samata-plugin-private`: 运行 `npm test`。
- `samata-plugin-private`: 运行 `npm run build --workspaces --if-present`。
- 重启 Samata 后复测 `generate_image_codex`，预期不再出现 `Reading additional input from stdin...` 导致的固定超时。

## Memory Note

继续遵循用户约定：每次代码改动都写入 `docs/plan` 留档；当前会话没有长期记忆写入工具，因此以计划文档记录。
