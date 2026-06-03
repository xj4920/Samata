# Samata Server Startup Keepalive

## Summary

重启 Samata 检查 `codex_agent` 插件加载时发现：前台启动可以完成插件加载和 CLI API 监听，但后台启动将 stdin 连接到 `/dev/null` 后，进程可能在飞书 bot 初始化阶段提前退出，尚未进入 server 分支里的 CLI API 监听和保活逻辑。

## Key Changes

- 在 `src/index.ts` 中提前判断 server 模式。
- server 模式进入 `main()` 后立即创建 keepalive timer，避免异步 bot 初始化阶段因缺少活跃 handle 而退出。
- `gracefulShutdown()` 中清理 keepalive timer，保持原有优雅关闭行为。

## Validation Plan

- 执行 `node --import tsx/esm src/index.ts --server < /dev/null`，确认应用能完成完整初始化并进入 CLI API 监听。
- 在当前 Codex tool 环境中，普通 `nohup`/`npm run start` 后台子进程会被会话生命周期影响；最终使用 `screen` 托管 Samata 后台进程。
- 检查 `.samata.pid` 对应 wrapper 进程仍存在，Node 进程监听 `127.0.0.1:3457`。
- 检查 `http://127.0.0.1:3457/health` 返回 `{ "ok": true }`。
- 检查启动日志包含 `Plugin [codex_agent]: 2 tools loaded`、`Plugins initialized: 9 loaded` 和 `[CLI API] listening`。
- 复查 agent 工具枚举，确认每个 agent 都包含 `generate_image_codex` 与 `recognize_image_codex`。

## Memory Note

本次变更继续遵循用户约定：每次代码改动都写入 `docs/plan` 留档；当前 Codex 会话没有可用的长期记忆写入工具，因此以计划文档记录该约定。
