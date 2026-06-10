---
docModules:
  - platform
docTopics:
  platform: 数据库迁移
status: implemented
canonicalDocs:
  - /platform/deployment
---

# 清理空迁移与 migrations 账本

## 背景

Umzug 接入时保留过一个空 smoke migration，只用于证明 migration runner 会把文件迁移记录到现有 SQLite `migrations` 表。当前 `schema.ts` 已经没有 legacy `runOnce(...)`，该空迁移文件没有运行时 DDL/DML 价值。

运行库 `migrations` 表仍保留大量历史迁移记录，其中包括已经删除文件或已经折叠进当前 schema 的旧迁移 ID。删除空迁移文件后，当前仓库不再保留实际迁移文件，历史账本可清空，但表结构需要保留给未来 Umzug migration 使用。

## 决策

- 删除 `src/db/migrations/` 中的空 smoke migration 文件。
- 保留 `migrations` 表本身，仅清空当前运行库中的历史记录。
- 迁移 runner 单测不再依赖固定 smoke 文件，改为测试内创建临时 migration 文件验证 Umzug 能写入同一个 `migrations` 表。
- 清空 `migrations` 前备份 `data/samata.db`，后续若需审计历史迁移记录可从备份恢复查看。

## 改动清单

- 删除 `src/db/migrations/` 中的空 smoke migration 文件。
- 更新 `tests/unit/schema/migrations.test.ts`：
  - 测试内创建临时 `.js` migration。
  - 使用 `createMigrator({ migrationsGlob })` 执行临时 migration。
  - 验证临时 migration ID 写入 `migrations` 表，并保留幂等与 storage log/unlog 测试。
- 运行时数据库执行 `DELETE FROM migrations`，保留空表。
- 清空前备份路径：`data/backups/cleanup-empty-migrations-20260610T084835Z/samata.db`。

## 验证命令

已执行：

```bash
find src/db/migrations -maxdepth 1 -type f -print
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('data/samata.db', { readonly: true, fileMustExist: true });
console.log(db.prepare('SELECT COUNT(*) AS c FROM migrations').get());
console.log(db.pragma('integrity_check'));
db.close();
NODE
rg -n "20260610_0001_migration_runner_smoke|migration_runner_smoke" src tests
npm run test:unit -- tests/unit/schema/migrations.test.ts
git diff --check
```

结果：

- `src/db/migrations/` 当前没有迁移文件。
- `migrations` 表保留，记录数为 `0`。
- `PRAGMA integrity_check` 返回 `ok`。
- smoke migration 代码/测试引用检查无命中。
- `tests/unit/schema/migrations.test.ts` 通过：1 个测试文件，3 个测试。

## Commit Hash

待提交后补充。
