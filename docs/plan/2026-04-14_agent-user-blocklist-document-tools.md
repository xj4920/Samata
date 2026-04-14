# Agent 成员 user blocklist：文档导入/删除

## 目标

普通成员（非 agent 实例 admin）不应调用 `import_document`、`delete_document`。实现方式：在 `user_tools_mode = 'blocklist'` 时，把这两项加入 `user_tools_list`（该列表中的名称会从成员可见工具集中剔除）。

## 行为说明

- 工具过滤：`src/llm/agents/config.ts` 中 `getAgentTools()`，非 admin 且 `user_tools_mode === 'blocklist'` 时，对 `user_tools_list` 中的工具名执行 `effectiveNames.delete`。
- Agent admin 仍按 agent 层 `tools_mode` / `tools_list` / `block_tools` 计算，不受成员 blocklist 的额外收紧（同函数中 `isAdmin` 为 true 时跳过 Step 2）。

## 代码与迁移触点

1. **`src/db/schema.ts` — `MEMBER_MUTATION_BLOCK`**（`seed-member-default-blocklist`）  
   默认成员变异块常量包含 `import_document`、`delete_document`，与「新库 / 文档对照」一致。注意：`runOnce` 已执行过的库不会重跑该 seed。

2. **`user-blocklist-add-document-tools`**（既有）  
   仅处理 `user_tools_list IS NOT NULL` 的 blocklist 行。

3. **`user-blocklist-document-tools-nullsafe`**（新增）  
   处理全部 `user_tools_mode = 'blocklist'` 的行，`user_tools_list` 为空则按 `[]` 合并后再写回，补齐 NULL 列表漏网。

## 验证

- 启动应用触发 `initSchema`，检查 `migrations` 表是否登记 `user-blocklist-document-tools-nullsafe`。
- 非 admin 成员在 blocklist agent 上应看不到 `import_document` / `delete_document`；实例 admin 仍可见（若 agent 层未单独 block）。
