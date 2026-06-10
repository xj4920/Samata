---
docModules:
  - platform
  - permissions
docTopics:
  platform: 数据库初始化与生产自举
  permissions: Agent 工具权限
status: implemented
canonicalDocs:
  - /platform/deployment
  - /permissions/tool-access
---

# Schema Seed 清理与生产 Bootstrap 脚本

## 背景

`src/db/schema.ts` 历史上同时承担 DDL、补丁式 migration、业务 seed、bot seed、agent 权限修正等职责。随着生产 agent 与企微 bot 绑定进入运行期配置，这些逻辑继续留在 schema 初始化中会导致新库启动时自动写入历史业务 agent、人员、bot 与工具权限。

本次目标是把 schema 收敛为纯 DDL 加最小平台自举，生产环境所需的 `ticlaw`、`otcclaw` agent 以及 `admin`、`ticlaw`、`otcclaw` 的企微 bot、成员与权限改为由本地忽略配置驱动的 bootstrap 脚本创建和更新。

## 决策

- `schema.ts` 删除全部 legacy `runOnce(...)`，最终结构直接折叠到顶部 DDL。
- 默认启动只幂等保留 `admin-001/admin` 用户、`agent-admin/admin` agent，以及 `admin-001` 对 admin agent 的管理员 membership。
- 业务 agent、企微 bot、tools、成员、权限、清理策略交给 `scripts/bootstrap-production.ts`，配置来源为 gitignored 本地 JSON。
- `admin` agent 由系统默认自举，不再要求写入 production bootstrap agent 配置；生产 bootstrap 默认 dry-run，`--apply` 写库前备份 `data/samata.db`。
- bootstrap 清理策略改为删除所有非目标 agent，而不是在源码中硬编码历史旧 agent 名单。
- `scripts/import-xbase.ts` 必须显式指定目标 agent；`SAMATA_AGENT` 只作为环境默认值，不再有内置默认 agent。
- 旧 agent 活跃配置、e2e 与测试 fixture 名称全部删除或中性化；历史 `docs/plan/**` 保留。

## 改动清单

- `src/db/schema.ts`
  - 删除全部 `runOnce(...)` 与历史 seed/补丁逻辑。
  - 将当前最终表结构折叠进 DDL，包含 users/display_name、clients 最新字段、skills agent 字段、knowledge/document_id、documents、pricing_quotes、telemetry_turn、索引等。
  - `ensurePlatformBootstrap()` 仅创建 admin 用户、admin agent 与 admin membership。
- `scripts/bootstrap-production.ts`
  - 新增生产 bootstrap 脚本，支持 `--config`、`--dry-run`、`--apply`、`--json`、`--export-current`。
  - 校验配置必须包含 `admin`、`ticlaw`、`otcclaw` 及各自企微 bot。
  - 支持 upsert agents、members、bot_apps、agent_assignments，并清理非目标 agent、非目标 assignment、非目标成员与定时任务等运行期记录。
  - target agent 的成员权限会收敛到 JSON 显式列出的成员集合，dry-run 会展示待清理成员。
- `config/production-bootstrap.example.json`
  - 新增示例配置，包含 `ticlaw` / `otcclaw` agent、三个目标企微 bot 环境变量占位、tools、成员和权限；`admin` agent 依赖系统默认自举。
- `.gitignore`
  - 忽略 `config/production-bootstrap*.json`，保留 example。
- `scripts/import-xbase.ts`
  - 支持 `--agent <name>` / `--agent=<name>`。
  - 未提供 `--agent` 且无 `SAMATA_AGENT` 时失败并打印用法。
  - state 文件改为 `data/import-xbase-state.<agent>.json`。
  - CLI session 创建后校验实际 agent 与目标 agent 一致，避免导入到错误 agent。
- 旧 agent 活跃内容清理
  - 删除旧 `.files.json`、旧 e2e、`scripts/wework-switch.sh`。
  - 测试 fixture 改为 `standard-test`、`learning-test`、`all-tools-test` 等中性名称。
  - 待办工具的跨 agent 视角由旧 agent 特判改为 admin agent 平台视角。
  - 文档与示例配置中的旧 agent 示例替换为 `ticlaw` / `otcclaw`。

## 验证命令

已执行：

```text
git pull --ff-only
npm run test:unit -- tests/unit/schema/schema.test.ts tests/unit/schema/migrations.test.ts
npm run test:unit -- tests/unit/config/agent-tool-binding.test.ts tests/unit/config/agent-config.test.ts tests/unit/config/rbac.test.ts
npm run test:unit -- tests/unit/tools/todo.test.ts tests/unit/tools/reminder.test.ts tests/unit/tools/schedule.test.ts tests/unit/tools/skill.test.ts tests/unit/tools/knowledge.test.ts tests/unit/tools/image-context.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts tests/unit/config/prompt-identity.test.ts tests/unit/config/wework-session.test.ts
npx tsx scripts/bootstrap-production.ts --config config/production-bootstrap.example.json --dry-run --json
npx tsx scripts/import-xbase.ts --help
rg -n "runOnce\\(" src/db/schema.ts
rg -n "alter-ego|doctor|tutor|potato|falcon|\\bman\\b" src scripts config tests docs --glob '!docs/plan/**'
npx tsc --noEmit
npm run docs:plan-sync
git diff --check
```

## 验证结果

- `git pull --ff-only`：已经是最新。
- schema/migrations 单测通过：2 个测试文件，38 个测试。
- config 单测通过：3 个测试文件，37 个测试。
- 改名影响的工具/服务单测通过：9 个测试文件，56 个测试。
- `bootstrap-production` dry-run JSON 可正常输出，当前本地 DB 中的非目标 agent 会作为清理候选展示。
- `import-xbase --help` 可正常输出新用法。
- `rg -n "runOnce\\(" src/db/schema.ts` 无匹配。
- 旧 agent 名活跃残留扫描无匹配。
- `npx tsc --noEmit` 通过。
- `npm run docs:plan-sync` 通过并更新 `docs/.vitepress/plan-index.generated.ts`；输出仍有既有历史 plan 缺少 frontmatter 的 warning/error，本次新增文件未被点名。
- `git diff --check` 通过。

## Commit Hash

- 实现提交：`6d22e60a7faa7334dd005aad707e8c47f06848aa`
- 留档回填提交：本段所在提交。

## 构建与运行影响

- 影响启动期 schema 初始化和生产部署/自举流程；部署到运行环境后需要重新构建或发布 runtime / Docker image，并重启服务。
- 不新增 npm 依赖。
- 本次验证未执行 `--apply`，未主动修改当前 `data/samata.db`。
