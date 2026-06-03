# Todo List Tracking Tools

**Date**: 2026-03-26

## 背景

为 Samata 多 agent 系统增加 todo list 跟踪能力，让 agent 可以帮用户创建、查询、更新和删除待办事项。Todo 按 agent 和用户隔离。

## 实现范围

### 新增文件
- `src/commands/todo.ts` — 业务逻辑层
- `src/tools/todo-tools.ts` — 工具定义和 handler

### 修改文件
- `src/db/schema.ts` — 新增 `todos` 表 + migration（含向已有 agent 添加 todo 工具）
- `src/llm/tool-types.ts` — 新增 4 个输入类型
- `src/tools/index.ts` — 注册 todo-tools 模块
- `src/llm/agents/config.ts` — 将 4 个 todo 工具加入 `common` preset

## 数据库设计

```sql
CREATE TABLE IF NOT EXISTS todos (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT REFERENCES agents(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id),
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done')),
  priority    TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
  due_date    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 工具列表

| 工具名 | 说明 |
|--------|------|
| `create_todo` | 创建 todo，支持 title/description/priority/due_date |
| `list_todos` | 列出 todos，默认只显示未完成，支持 status/priority 过滤 |
| `update_todo` | 更新 todo 字段（含标记完成） |
| `delete_todo` | 删除 todo |
