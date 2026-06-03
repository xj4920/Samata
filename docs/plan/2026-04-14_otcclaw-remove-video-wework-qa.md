---
docModules: []
docTopics: {}
canonicalDocs: []
status: archived
---

# otcclaw 移除 generate_video / extract_wework_qa

## 目标

衍语（`agents.name = 'otcclaw'`）的有效工具集中不再包含 `generate_video` 与 `extract_wework_qa`。

## 原因

- `standard` 模式：`getAgentTools()` 使用 `(COMMON_SET ∪ tools_list ∪ 插件) \ block_tools`（见 `src/llm/agents/config.ts`）。
- `extract_wework_qa` 仅出现在 otcclaw 的 **tools_list**（迁移 `migrate-agents-to-standard-mode` 的 allow 列表）。
- `generate_video` 来自 **COMMON_SET**，不能从全局集合删除；对 otcclaw 通过 **block_tools** 排除。此前仅写入 **user_tools_list** 的 blocklist 无法禁止 Agent 管理员使用该工具。

## 代码与迁移

1. **`migrate-agents-to-standard-mode`**（`src/db/schema.ts`）：otcclaw 的 allow 去掉 `extract_wework_qa`；`block_tools` 基准为 `['generate_video']`。
2. **`user-blocklist-otcclaw-add-client-video`**：`toAdd` 不再包含 `generate_video`（新库不在用户层重复 block）。
3. **`runOnce('otcclaw-remove-generate-video-extract-wework-qa')`**：已存在库一次性从 `tools_list` 移除 `extract_wework_qa`、合并 `block_tools` 含 `generate_video`、从 `user_tools_list` 去掉 `generate_video`（若存在）。

## 验证

启动应用触发 `initSchema()` 后，检查 otcclaw 的 `tools_list` / `block_tools`，并对 otcclaw 配置调用 `getAgentTools(..., isAdmin: true)`，确认工具名中无上述两项。
