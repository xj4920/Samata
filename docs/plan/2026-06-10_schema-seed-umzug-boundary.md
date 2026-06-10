---
docModules:
  - platform
docTopics:
  platform: 数据库初始化
status: implemented
canonicalDocs:
  - /platform/deployment
---

# Schema/Seed 边界与 Umzug Migration 入口

## 背景

Code issue `#5062` 提出：`src/db/schema.ts` 同时承担 SQLite 建表、历史 migration、默认 seed、工具授权演进、bot app seed、测试/生产 bot 切换等职责，导致新环境 Bot 配置来源不透明，也让后续 schema 演进继续堆进一个文件。

前序已经完成多轮止血：

- 删除 `WEWORK_AIBOT_*` 自动 seed `wework-bot` 的历史逻辑。
- 删除 `seed-ticlaw-agent`、`wework-test-bot-setup`、私有 agent、硬编码用户/alias 等 seed。
- 将业务插件工具绑定改为 `scripts/bind-agent-tools.ts` 显式脚本。
- 删除 `schema.ts` 中历史 `*_new` 临时重建表 migration。

本次目标不是一次性迁移全部历史 `runOnce`，而是建立后续新增 migration 的新入口，停止继续向 `schema.ts` 末尾追加 migration/seed。

## 决策

- 引入 Umzug 作为新 migration runner；不替换现有 `better-sqlite3` raw SQL 访问方式。
- 复用现有 SQLite `migrations(id, applied_at)` 表作为 Umzug storage，避免双 migration 状态表。
- 保留 `initSchema()` 和历史 `runOnce` 作为 legacy bridge，降低老库启动风险。
- 新增 `initDatabase()`：先执行 legacy `initSchema()`，再执行 Umzug migrations。
- 主服务与 Bot 独立入口改用 `await initDatabase()`。
- 新增 migration 一律进入 `src/db/migrations/`，不再追加到 `src/db/schema.ts`。
- 本次不恢复 `WEWORK_AIBOT_*` 自动写库；WeWork bot 继续通过 SQLite `bot_apps` 和 `/agent bot-app`、`/agent assign` 管理。
- 本次不删除或改写当前 `data/samata.db` 的历史 bot、私有 agent、scheduled task；存量治理需单独审计和人工确认。
- 经人工确认，`doctor`、`tutor`、`alter-ego`、`browser`、`potato` 等非 `admin` / `ticlaw` / `otcclaw` 的默认 Agent 与权限补丁不再迁出到 seed，直接从 legacy `runOnce` 中删除。
- 单元测试需要这些非核心 Agent 时，由 `tests/helpers/seed-data.ts` 显式插入测试 fixture，不再依赖生产 schema 启动 seed。

## 改动清单

- `package.json` / `package-lock.json`
  - 新增依赖 `umzug`。
  - 新增脚本 `npm run db:migrate`。
- `src/db/migration-storage.ts`
  - 新增 `sqliteMigrationStorage()`，用现有 `migrations` 表实现 Umzug storage。
- `src/db/migrate.ts`
  - 新增 Umzug runner、TS/JS migration 动态加载和 CLI 入口。
- `src/db/migrations/20260610_0001_migration_runner_smoke.ts`
  - 新增无数据副作用的 smoke migration，用 migration 记录验证 runner 链路。
- `src/db/schema.ts`
  - 新增 `initDatabase()`，串联 legacy schema 与 Umzug migration。
  - 删除非核心 Agent 的默认 seed 和工具权限 `runOnce`：`doctor`、`tutor`、`alter-ego`、`browser`、`potato` 不再由生产 schema 自动创建或补权。
  - 将 `migrate-agents-to-standard-mode` 收窄为仅处理 `otcclaw` 历史标准化，不再扫过其它 Agent。
- `src/index.ts`、`src/feishu-entry.ts`、`src/wework-entry.ts`、`src/telegram-entry.ts`
  - 启动期改用 `await initDatabase()`。
- `scripts/bind-agent-tools.ts`、`src/scripts/import-customers.ts`
  - 脚本入口改用 `initDatabase()`，确保未来新 migration 已应用。
- `tests/helpers/unit-harness.ts`、`tests/helpers/test-harness.ts`
  - 单测 harness 改用 `initDatabase()`。
- `tests/helpers/seed-data.ts`
  - 新增测试专用 `doctor`、`tutor`、`alter-ego` fixture，供工具/Agent 配置测试显式使用。
- `tests/unit/schema/schema.test.ts`
  - schema 纯初始化时关闭测试 Agent fixture，验证生产 schema 不再 seed 非核心 Agent。
- `tests/unit/schema/migrations.test.ts`
  - 新增 Umzug storage 和 runner 幂等测试。
- `docs/platform/deployment.md`、`docs/permission-system.md`、`README.md`
  - 更新 migration/seed 边界和 Bot 配置来源说明。

## 验证命令

已执行：

```text
npm run test:unit -- tests/unit/schema/migrations.test.ts
npm run test:unit -- tests/unit/schema/schema.test.ts tests/unit/schema/migrations.test.ts
npm run test:unit -- tests/unit/schema/schema.test.ts tests/unit/schema/migrations.test.ts tests/unit/config/agent-config.test.ts tests/unit/tools/todo.test.ts tests/unit/tools/reminder.test.ts tests/unit/tools/schedule.test.ts
npm run test:unit -- tests/unit/schema/schema.test.ts tests/unit/schema/migrations.test.ts tests/unit/config/agent-tool-binding.test.ts tests/unit/config/agent-config.test.ts tests/unit/tools/schedule.test.ts
npx tsc --noEmit
npm run docs:plan-sync
rg -n "seed-default-feishu-apps|seed-ticlaw-agent|wework-test-bot-setup|seed-known-user-aliases-v2|seed-falcon-potato-man-agents|WEWORK_AIBOT_NAME|WEWORK_AIBOT_AGENT|WEWORK_AIBOT_AUTO_START" src package.json docs/platform .env.example
npx tsx scripts/bind-agent-tools.ts --help
node -e "const fs=require('fs');const st=fs.statSync('data/samata.db'); console.log(JSON.stringify({size:st.size, mtimeMs:Math.trunc(st.mtimeMs)}))"
git diff --check
```

## 验证结果

- `npm run test:unit -- tests/unit/schema/migrations.test.ts` 通过：1 个测试文件，3 个测试。
- `npm run test:unit -- tests/unit/schema/schema.test.ts tests/unit/schema/migrations.test.ts` 通过：2 个测试文件，37 个测试。
- 非核心 Agent 删除后的 schema / config / todo / reminder / schedule 组合验证通过：6 个测试文件，93 个测试。
- 受影响链路组合单测通过：5 个测试文件，82 个测试。
- `npx tsc --noEmit` 通过。
- `npm run docs:plan-sync` 通过，plan index 已是最新；输出仍包含既有历史 plan 缺少或未配置 frontmatter 的提示，本次新增文件未被点名。
- `rg` 硬编码回流检查无匹配。
- `rg` 删除清单 runOnce 名称检查无匹配。
- `npx tsx scripts/bind-agent-tools.ts --help` 通过。
- `git diff --check` 通过。
- `data/samata.db` 验证前后均为 `31166464` 字节、`mtimeMs=1780755388216`，确认当前真实运行库未被写入。

## Commit Hash

- 待提交后回填。

## 构建与运行影响

- 新增 npm 依赖 `umzug`，部署/runtime/Docker image 需要重新安装依赖并重新构建。
- 影响启动期数据库初始化：服务启动将先执行 legacy `initSchema()`，再执行 Umzug migrations。
- 当前未执行 `npm run db:migrate` 写入真实 `data/samata.db`；现有运行库不在本次自动清理范围内。
