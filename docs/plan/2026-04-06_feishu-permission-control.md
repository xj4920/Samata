# 飞书用户权限控制修复

> 日期：2026-04-06 | 状态：已完成

## 背景

飞书 channel 进来的用户缺乏完整的权限管理：用户身份不可读、命令/工具未按角色过滤、执行上下文缺失。

## 问题分析

### 1. 飞书用户身份信息缺失

用户名使用 `user_xxxx`（open_id 后 6 位），完全不可读。`getSessionForInstance` 首次创建 session 时未调用飞书 API 获取真实姓名。

### 2. FAQ 写命令对所有用户可见

`/faq-add`、`/faq-update`、`/faq-del` 未设置 `requiredRole`，`shouldShowCommand()` 放行，`/help` 对所有用户列出这些命令。

### 3. `handleEvent` 未设置执行上下文

飞书 bot 处理消息时未用 `runWithExecutionContext({ channel: 'feishu' })` 包裹，`getExecutionChannel()` 返回默认值 `'system'`，导致 channel 判断不准确。

### 4. 非 admin 用户能看到写入工具

所有 agent 的 `userToolsMode` 默认 `'inherit'`，非 admin 用户 inherit 了和 admin 一样的工具集（包括 `add_knowledge`、`save_memory`、`save_skill` 等写入工具）。

### 5. `isAgentAdmin` 传参 bug

`isAgentAdmin()` 期望 `agentId`（UUID），但飞书 bot 中传的是 `agentName`（如 `otcclaw`），导致所有飞书用户的 admin 判断都返回 false。

### 6. username UNIQUE 约束冲突

飞书联系人 API 返回的真实姓名可能与已有用户重名，`getOrCreateUser` 的 INSERT/UPDATE 触发 `UNIQUE constraint failed`。

## 修改方案

### 修改 1：飞书用户身份解析

**文件**: `src/feishu/api.ts`、`src/feishu/bot.ts`

- `FeishuAPI.getUser()` → `getUserByOpenId()`，改用 contact v3 端点 `GET /contact/v3/users/:open_id?user_id_type=open_id`（需要 `contact:contact.base:readonly` 权限）
- `getSessionForInstance()` 改为 async，首次创建 session 时调用 API 获取真实姓名
- 所有调用处加 `await`，相关函数改为 async

### 修改 2：FAQ 写命令权限控制

**文件**: `src/commands/router.ts`

`faq-add`、`faq-update`、`faq-del` 添加 `requiredRole: 'agent_admin'`。

### 修改 3：执行上下文包裹

**文件**: `src/feishu/bot.ts`

`handleEvent()` 整体用 `runWithExecutionContext({ channel: 'feishu' })` 包裹。

### 修改 4：非 admin 工具降级

**文件**: `src/llm/agents/config.ts`

`getAgentTools()` 中 `userToolsMode === 'inherit'` + `isAdmin === false` 时，降级到 `readonly` preset：
- `search_knowledge`、`get_status_summary`、`list_skills`、`get_skill`、`run_skill`、`search_memory`

### 修改 5：修复 `isAgentAdmin` 传参

**文件**: `src/feishu/bot.ts`

`isAgentAdmin(session.agentName)` → `isAgentAdmin(getAgent(session.agentName).id)`。

### 修改 6：处理 username UNIQUE 冲突

**文件**: `src/auth/rbac.ts`、`src/db/schema.ts`

- 新增 `resolveUniqueUsername()`：检查 username 是否被其他用户占用，冲突时加 `_xxxx`（id 末 4 位）后缀
- 修正 seed migration 中硬编码的飞书用户名（`tutor-admin` → `feishu_d26f` 等）
- 新增 `fix-feishu-hardcoded-usernames` migration 修复已有数据

## 权限模型总结

| 层级 | 字段/表 | 说明 |
|------|---------|------|
| 全局系统角色 | `users.role` = `admin` / `user` | CLI + admin = `isSystemAdmin()` |
| Agent 实例权限 | `agent_members.role` = `admin` / `user` | `isAgentAdmin(agentId)` |
| 工具集过滤 | `agents.user_tools_mode` | `inherit` 时非 admin 降级到 readonly |

飞书用户 `users.role` 固定为 `'user'`。只有 CLI admin 可通过 `agent_members` 表授予飞书用户对特定 agent 的 admin 权限。
