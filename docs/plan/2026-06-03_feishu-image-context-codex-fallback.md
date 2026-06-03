# Feishu Image Context Codex Fallback

## Summary

飞书图片消息已经成功下载并保存到本地路径，但自动图片描述依赖 MiniMax VLM；当 MiniMax 返回额度错误时，`runAgenticChat` 在写入用户消息前抛错并回滚本轮历史，导致下一句“调用 Codex 识别图片”无法从上下文中读取刚发送的图片路径。

## Root Cause

- 图片消息入口会把图片保存到本地，并将路径写入文本：`用户发送了图片，已保存至 ...`。
- `runAgenticChat` 在真正 push user message 到 history 前，会优先调用 `describeImageWithFallback`。
- 当所有图片描述 provider 都失败时，该异常直接抛出，调用方返回 `AI 请求失败`。
- 因为本轮 user message 没有进入 history，后续文字消息看到的是空历史或不含图片路径的历史。

## Key Changes

- `ImageInput` 增加可选 `path` 字段，用于携带渠道下载后的本地图片路径。
- 飞书图片、post 图片、图片文件下载后把本地路径写入 `ImageInput.path`。
- 飞书 session 记录 `lastImagePaths`，当用户后续说“刚刚/上面那张图/识别图片/转文字”等，会自动把最近图片路径注入给 agent。
- `runAgenticChat` 中图片自动描述失败时不再中断整轮，而是保留图片路径并提示 agent 使用 `recognize_image_codex`，避免再次向用户索要路径。

## Validation Plan

- 运行 `npx vitest run tests/unit/tools/image-context.test.ts`。
- 运行 `npx vitest run tests/unit/schema/schema.test.ts` 做基础回归。
- 重启 Samata 后检查 `codex_agent` 仍加载 2 个工具。
- 手工复测：飞书发送图片后，即使 MiniMax VLM 额度失败，agent 应能使用保存路径调用 `recognize_image_codex`；下一句“调用 Codex 工具识别图片”也应自动带上最近图片路径。

## Memory Note

继续遵循用户约定：每次代码改动都写入 `docs/plan` 留档；当前会话没有长期记忆写入工具，因此以计划文档记录。
