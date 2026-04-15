---
name: document import actor
overview: 修复 agent 触发 `document import` 时 `knowledge.created_by` / `documents.created_by` 被错误记为 `admin-001` 的问题。优先采用最小闭环方案：在导入链路中显式传递调用用户，而不是在异步流程末尾再读取全局 `currentUser`。
todos:
  - id: thread-actor-into-import
    content: 为 `importDocument()` 增加显式调用用户参数，并在函数入口固定 actor
    status: completed
  - id: pass-actor-from-tool
    content: 在 `import_document` tool handler 中把当前会话用户传入导入命令
    status: completed
  - id: update-related-callers
    content: 同步调整 `reimportDocument()` 和其他调用点，避免签名变更引发行为不一致
    status: completed
  - id: verify-created-by
    content: 验证文档与知识记录的 `created_by` 都落到真实用户而非 `admin-001`
    status: completed
isProject: false
---

# 修复 Document Import Created By

## 结论
当前问题不是 `document import` 直接写死了 `admin-001`，而是导入链路在异步处理结束后才读取全局用户：

- [`/home/dministrator/source/otcclaw/src/commands/document-import.ts`](/home/dministrator/source/otcclaw/src/commands/document-import.ts) 在 `loadAndChunk(...)` 之后才执行 `const user = getCurrentUser()`，随后把 `user.id` 写入 `documents.created_by` 和 `knowledge.created_by`
- [`/home/dministrator/source/otcclaw/src/tools/document-tools.ts`](/home/dministrator/source/otcclaw/src/tools/document-tools.ts) 的 agent 工具调用 `importDocument(...)` 时没有显式传入用户
- [`/home/dministrator/source/otcclaw/src/auth/rbac.ts`](/home/dministrator/source/otcclaw/src/auth/rbac.ts) 里的 `currentUser` 是进程级全局变量，不是 `AsyncLocalStorage`
- 多个 bot/server 入口会把默认用户恢复成 `admin-001`，所以在异步/并发场景里，导入结束时读取到的用户可能已经漂移

## 实施方案
1. 在 [`/home/dministrator/source/otcclaw/src/commands/document-import.ts`](/home/dministrator/source/otcclaw/src/commands/document-import.ts) 给 `importDocument()` 增加显式 actor 参数，例如 `actorUserId` 或 `actor`，并在函数入口立刻确定该值，后续统一用它写入 `documents` 和 `knowledge`。
2. 在 [`/home/dministrator/source/otcclaw/src/tools/document-tools.ts`](/home/dministrator/source/otcclaw/src/tools/document-tools.ts) 的 `handleImportDocument()` 中读取当前调用用户并显式传给 `importDocument()`，保证 agent tool 调用链不再依赖隐式全局状态。
3. 保持 CLI/现有命令兼容：如果还有非 tool 调用路径，可允许 `importDocument()` 在未传 actor 时回退到当前用户，但回退逻辑要在函数最开始就完成，不能放在异步步骤后。
4. 检查 `reimportDocument()` 与其他 `importDocument()` 调用点，确保签名变更后仍能正确透传创建人。
5. 增加一次针对 agent 导入路径的验证，确认新导入的 `documents.created_by` 与 `knowledge.created_by` 都等于真实会话用户，而不是 `admin-001`。

## 范围控制
本次先不做全局 `currentUser` 上下文重构。更彻底的方案是把用户上下文迁移到 `AsyncLocalStorage`，与 [`/home/dministrator/source/otcclaw/src/runtime/execution-context.ts`](/home/dministrator/source/otcclaw/src/runtime/execution-context.ts) 的 channel 机制保持一致，但这会扩大改动面，适合后续单独处理。