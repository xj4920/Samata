# 修复 Agent 删除的级联清理

## 根因

删除 agent 时报 `FOREIGN KEY constraint failed`，原因是 `documents` 表的外键引用了 `agents(id)` 但未设置 `ON DELETE CASCADE`。

## 影响范围

### 引用 `agents(id)` 的所有表

**已由 CASCADE 自动处理：**
- `agent_assignments`、`agent_members`、`memory`、`knowledge_agents`、`todos`、`wrong_questions` — ON DELETE CASCADE
- `skills` — ON DELETE SET NULL

**阻塞删除（本次 bug）：**
- `documents` — `REFERENCES agents(id)` 未设 ON DELETE = 默认 RESTRICT

**无 FK 约束但存有 `agent_id`（需显式清理）：**
- `reminders`、`scheduled_tasks`、`pricing_quotes`、`health_records`、`health_files`
- `telemetry_turn` — 保留，用于审计

**文件系统数据：**
- `data/documents/{agentName}/`
- `data/workspaces/{agentName}/`
- `data/wrong-questions/{agentId}/`
- `/tmp/samata/sandboxes/{agentName}/`

## 实施步骤

1. 在 `src/db/schema.ts` 添加 migration `fix-documents-agent-fk-cascade`，重建 `documents` 表给 `agent_id` 加上 `ON DELETE CASCADE`
2. 改写 `src/llm/agents/config.ts` 的 `deleteAgent()`，在删除 agent 行前先清理文件系统和非 FK 表数据

## 验收标准

- `/agent del <name>` 不再报 FK 错误
- 所有关联 DB 数据清零
- 文件系统目录被删除
