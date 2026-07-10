---
docModules:
  - platform
docTopics:
  platform: 用户与权限
status: implemented
---

# CLI 用户列表按创建时间倒序展示

## 背景

CLI 下 `/user list` 原先按用户名排序。用户管理新企微自动创建用户时，更需要优先看到最近创建的用户，因此希望列表按用户创建时间从新到旧展示。

## 决策

- 复用 `users.created_at` 字段作为排序依据，不新增数据库表或迁移。
- 查询层统一排序，避免各调用方自行排序。
- 同秒创建时使用 `username ASC` 作为稳定兜底顺序。
- CLI 表格展示“创建时间”列，让排序依据可见。

## 改动清单

- `src/auth/rbac.ts`
  - `UserListRow` 增加 `created_at`。
  - `getAllUsersWithAliasCount()` 查询带出 `users.created_at`。
  - 排序调整为 `created_at DESC, username ASC`。
- `src/commands/user.ts`
  - `/user list` 输出增加“创建时间”列。
- `tests/unit/commands/user.test.ts`
  - 通过局部 spy `log.print` 捕获 `/user list` 输出。
  - 新增用户列表创建时间倒序测试。
- `package.json` / `package-lock.json`
  - 版本从 `3.0.29` 递增到 `3.0.30`。

## 验证命令

```bash
npm run test:unit -- tests/unit/commands/user.test.ts
```

验证结果：通过，`tests/unit/commands/user.test.ts` 共 4 个用例通过。

## Commit Hash

- 实现提交：待提交。

## 构建与重启影响

本次改动影响运行时代码和 Docker image 内容；不新增依赖，不涉及数据库迁移。提交后如需要部署到运行容器，需要重新构建 image 并重启对应服务。
