# User Management CLI Execution Plan

## 需求理解 (Requirement Understanding)
系统管理员需���在 CLI 环境下对系统的用户（`users` 表）进行增删改查（CRUD）操作。这些操作应仅对拥有 `admin` 角色的用户开放。

## 影响范围 (Scope)
- **数据库操作**: `src/auth/rbac.ts`
  - 新增 `createUser`, `updateUser`, `deleteUser`, `getUser` 数据库交互逻辑。
- **CLI 命令**: `src/commands/user.ts` (新增)
  - 实现 `user` 相关的子命令，如 `list`, `add`, `update`, `delete`。
- **CLI 入口**: `src/index.ts`
  - 注册 `user` 相关的 commander 命令。

## 详细实施步骤 (Implementation Steps)
1. **完善 RBAC 模块 (`src/auth/rbac.ts`)**:
   - 增加 `createUser(username: string, role: Role): User` 函数。
   - 增加 `updateUser(id: string, updates: Partial<User>): User` 函数。
   - 增加 `deleteUser(id: string): void` 函数。
   - 增加 `getUser(id: string): User` 函数。
2. **编写 CLI 命令 (`src/commands/user.ts`)**:
   - 校验当前登录用户是否为 `admin` (`requireAdmin()`)。
   - `listUsersCommand`: 格式化输出所有用户信息（可使用 `cli-table3` 或 `utils/table.ts`）。
   - `addUserCommand(username, role)`: 调用创建逻辑并输出结果。
   - `updateUserCommand(id, role)`: 调用更新逻辑并输出结果。
   - `deleteUserCommand(id)`: 调用删除逻辑并输出结果。
3. **注册命令 (`src/index.ts`)**:
   - 在主程序入口挂载 `user` 命令组及其子命令。

## 验收标准 (Acceptance Criteria)
- 管理员可成功在 CLI 运行 `gemini user list` 并看到以表格形式展示的用户列表。
- 管理员可运行 `gemini user add <username> [role]` 添加新用户，并且同名用户报错。
- 管理员可运行 `gemini user update <id> --role <role>` 修改用户角色。
- 管理员可运行 `gemini user delete <id>` 删除用户。
- 非管理员执行上述操作应被拒绝，提示权限不足。
