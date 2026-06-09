---
docModules:
  - platform
  - permissions
docTopics:
  platform: 数据库初始化
  permissions: Agent 权限
status: implemented
canonicalDocs:
  - /platform/deployment
  - /permissions/tool-access
---

# 清理 schema.ts 硬编码 Seed

## 背景

`src/db/schema.ts` 中仍保留部分环境、人员、bot、私有 agent 相关的历史 `runOnce` seed。这些逻辑会在新库初始化或未执行过对应 migration 的库启动时自动写入 Feishu/WeWork bot、真实人员身份映射、私有 agent 与 membership，超出了平台 schema 初始化职责。

本次清理目标是停止未来自动写入这些硬编码配置，同时不删除当前运行库中已经存在的数据。

## 决策

- 删除指定的硬编码 seed；不新增任何清理现有数据的 SQL。
- 保留 `users.display_name` 字段迁移，只删除指定 Feishu 真实人员显示名回填。
- 保留现有 `data/samata.db`，不执行任何针对运行库的数据删除或迁移命令。
- 需要 `ticlaw` 的单测改为测试内显式创建 fixture，不再依赖 schema 自动 seed。
- 本次不引入 Umzug；Umzug migration/seed 边界重构另行规划。

## 改动清单

- `src/db/schema.ts`
  - 删除 `seed-default-feishu-apps`、`seed-ticlaw-agent`、`wework-test-bot-setup`。
  - 删除 `add-feishu-admin-users`、`add-doctor-admin-user`、`add-alter-ego-admin-36f292`。
  - 删除 `recover-cascade-deleted-data`、`seed-known-user-aliases-v2`。
  - 删除 `seed-falcon-potato-man-agents`、`ensure-falcon-block-tools-v2`。
  - 从 `add-users-display-name` 中删除指定 Feishu 用户显示名回填。
- `tests/unit/schema/schema.test.ts`
  - 增加新库不会自动 seed Feishu bot、TIClaw/WeWork test bot、私有 agent、指定人员/alias 的回归断言。
- `tests/unit/config/agent-config.test.ts`、`tests/unit/tools/file-tools-list-directory.test.ts`、`tests/unit/tools/wiki.test.ts`
  - 显式创建 `ticlaw` 测试 fixture，避免依赖 schema seed。

## 验证命令

已执行：

```text
npm run docs:plan-sync
npm run test:unit -- tests/unit/schema/schema.test.ts
npm run test:unit -- tests/unit/config/agent-config.test.ts
npm run test:unit -- tests/unit/tools/file-tools-list-directory.test.ts
npm run test:unit -- tests/unit/tools/wiki.test.ts
npm run test:unit -- tests/unit/schema/schema.test.ts tests/unit/config/agent-config.test.ts tests/unit/tools/file-tools-list-directory.test.ts tests/unit/tools/wiki.test.ts
rg -n "seed-default-feishu-apps|seed-ticlaw-agent|wework-test-bot-setup|add-feishu-admin-users|add-doctor-admin-user|add-alter-ego-admin-36f292|recover-cascade-deleted-data|seed-known-user-aliases-v2|seed-falcon-potato-man-agents|ensure-falcon-block-tools-v2" src/db/schema.ts
rg -n "cli_a93212c0b7b9dcc5|Ngdd5bLmxpgawK9ol3qRsbT4Navnq4Xa|aibVpgqdRX0aRtfu0351LN-Ehtu9BVzSmMo|YsXcl1XvqQ2NlV3YXRAsArKOYgctrUXkEKF86G0YiG2|aib-l7p7MyNNEpadH2ELbHpZ0ozjczqiaWE|4qra3bvf4bCZW8VAL6yWnPMhNupyRSQc6HAMCGneZd2|agent-falcon|agent-potato|agent-man" src/db/schema.ts
git diff --check
stat -c '%n %s %Y' data/samata.db
```

## 验证结果

- `npm run docs:plan-sync` 通过并更新 plan index；输出中仍有既有历史 plan 缺少或未配置 frontmatter 的提示，本次新增文件未被点名。
- `npm run test:unit -- tests/unit/schema/schema.test.ts` 通过：1 个测试文件，35 个测试。
- `npm run test:unit -- tests/unit/config/agent-config.test.ts` 通过：1 个测试文件，19 个测试。
- `npm run test:unit -- tests/unit/tools/file-tools-list-directory.test.ts` 通过：1 个测试文件，4 个测试。
- `npm run test:unit -- tests/unit/tools/wiki.test.ts` 通过：1 个测试文件，4 个测试。
- 合并定向验证通过：4 个测试文件，62 个测试。
- 两条 `rg` 静态核查均无匹配，确认指定 seed id、secret、bot id 与私有 agent id 不再出现在 `src/db/schema.ts`。
- `git diff --check` 通过。
- `data/samata.db` 验证前后均为 `31166464 1780755388`，确认真实运行库文件未变化。

## Commit Hash

- 待提交后回填。

## 构建与运行影响

- 影响启动期 schema 初始化行为；部署到运行环境后需要重新构建或发布 runtime / Docker image，并重启服务。
- 不新增 npm 依赖。
- 不修改当前 `data/samata.db`；现有运行库中的历史记录会继续保留。
