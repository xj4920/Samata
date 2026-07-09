---
docModules:
  - platform
docTopics:
  platform: 用户与权限
canonicalDocs:
  - /permission-system
status: implemented
---

# 企微用户管理与 Canonical ID 计划

## 背景

当前企微接入中，同一个自然人可能出现多个 Samata 用户 ID。例如许骏同时出现过 `wework_gzxujun`、`wework_user_gzxujun`、`wework_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ`、`wework_user_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ`。其中 `wework_<raw>` 是历史格式，`wework_user_<raw>` 是当前 raw userid 派生格式，但两者都不适合作为长期权限主体。

`agent_members.user_id` 是 agent 权限判断的实际来源。如果权限继续绑定在企微 raw userid 或历史格式上，同一个人在不同企微 raw userid 下会出现权限不一致，也会导致 ticlaw、otcclaw 等 agent 的管理员权限难以维护。

本次用户确认两个约束：

- 不再保留旧格式 `wework_<raw userid>`。
- 不调用企微用户接口，不读取手机号、邮箱、unionid、external profile 等额外资料。

因此系统只能基于触发消息中的原始企微 `from.userid` 做本地身份解析；无法自动判断 `gzxujun` 与 `wofvtgBgAAnfJpH24lr99a5QoP3QinaQ` 是否同一自然人。多 raw userid 合并必须通过本地 alias 管理完成。

## 目标状态

- `users.id` 只保存 Samata canonical user id，例如 `user-gzxujun`、`user-luanyinan`、`user-wework-<hash>`。
- `user_aliases.alias_user_id` 保存外部身份别名，例如 `wework_user_gzxujun`、`wework_user_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ`。
- `agent_members.user_id` 只绑定 canonical user id，不再绑定 `wework_*` 或 `wework_user_*`。
- 未绑定的新企微 raw userid 首次发消息时允许自动创建低权限 canonical user，并立即通过企微消息通知 `gzxujun` 进入用户管理处理。
- 自动创建用户不自动获得任何 agent 权限。

## 用户 ID 规则

### 已确认自然人

对已知用户，使用稳定 canonical id：

```text
许骏       -> user-gzxujun
栾宜男     -> user-luanyinan
唐洋       -> user-tangyang
刘航伸     -> user-liuhangshen
```

已知用户的企微 raw userid 只进入 alias：

```text
wework_user_<raw userid> -> user-<person>
```

以许骏为例：

```text
users:
  user-gzxujun

user_aliases:
  wework_user_gzxujun -> user-gzxujun
  wework_user_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ -> user-gzxujun

agent_members:
  ticlaw  + user-gzxujun + admin
  otcclaw + user-gzxujun + admin
```

### 未绑定新 raw userid

当一条企微消息携带此前未见过的 raw userid 时，系统自动创建待管理 canonical user：

```text
users.id       = user-wework-<hash(raw userid)>
users.username = wework_<raw userid suffix>
users.role     = user

user_aliases.alias_user_id     = wework_user_<raw userid>
user_aliases.canonical_user_id = user-wework-<hash(raw userid)>
```

该用户默认没有 `agent_members` 记录，因此不会自动成为 ticlaw 或 otcclaw 成员，更不会获得 agent admin 权限。

## 触发消息与原始用户信息

新用户创建必须由一条具体企微消息触发，而不是在 RBAC 层静默创建。创建时需要把触发消息中的原始上下文带入通知，便于管理员判断是否合并。

通知内容应包含：

```text
新建 canonical user:
  user-wework-<hash>

绑定 alias:
  wework_user_<raw userid>

原始企微用户信息:
  from: <frame.body.from 原始 JSON>
  userid: <frame.body.from.userid>
  msgid: <frame.body.msgid>
  chattype: <frame.body.chattype>
  chatid: <frame.body.chatid，群聊时存在>
  aibotid: <frame.body.aibotid>
  create_time: <frame.body.create_time>

来源:
  bot_id: <bot_apps.id>
  bot_name: <bot_apps.name>
  agent: <当前绑定 agent>
```

这些信息只来自企微消息 payload，不额外查询企微通讯录或 OAuth 接口。

## 管理员通知

自动创建新用户后，使用现有企微主动通知能力向 `gzxujun` 发送消息：

```text
SAMATA_WEWORK_USER_NOTIFY_TARGET=gzxujun
SAMATA_WEWORK_USER_NOTIFY_BOT=ticlaw
```

- `SAMATA_WEWORK_USER_NOTIFY_TARGET` 默认值为 `gzxujun`。
- `SAMATA_WEWORK_USER_NOTIFY_BOT` 默认值为 `ticlaw`，表示优先使用绑定到 ticlaw agent 的企微 bot；也支持填写 bot id 或 bot name。
- `SAMATA_WEWORK_USER_NOTIFY_BOT` 为空时优先复用当前收到消息的企微 bot。
- 通知失败不回滚用户创建，不阻断当前对话，只记录错误日志。

通知中的建议操作示例：

```text
/user alias add user-gzxujun wework_user_<raw userid> auto-merged-wework
/agent member add otcclaw user-gzxujun admin
/agent member add ticlaw user-gzxujun admin
```

如果该 raw userid 确认为新人，则管理员可保留自动创建的 `user-wework-<hash>`，再按需更新显示名和 agent membership。

## 涉及模块

### `src/auth/rbac.ts`

- 调整 WeWork 身份解析规则：canonical candidate 不再是 `wework_user_<raw>`。
- `collectExternalUserIds('wework', ...)` 只保留当前格式 `wework_user_<raw>`，不再注册旧格式 `wework_<raw>`。
- 增加可返回创建状态的解析函数，例如 `resolveExternalUserWithStatus()`，返回：

```ts
{
  user,
  created,
  aliasIds,
  rawUserId,
}
```

### `src/wework/session.ts`

- 会话创建时使用带状态的身份解析结果。
- 当 `created=true` 时，把触发消息上下文交给通知服务。
- 已存在 alias 或已存在 canonical user 时不重复通知。

### `src/wework/bot.ts`

- 在文本、图片、混合消息等入口收集触发消息上下文并传给 session。
- 反馈卡片点击用户也应通过统一身份解析获得 canonical user，不再直接使用 `buildCanonicalUserId('wework', ...)` 生成 `wework_user_<raw>`。

### `src/wework/notification-queue.ts`

- 复用现有企微主动推送队列。
- 不新增 SMTP 或邮件依赖。
- 将企微连接获取改为 resolver 注入，避免 `bot.ts` 与 `notification-queue.ts` 在新用户通知路径上形成循环 import。

### 配置与文档

- `.env.example` 增加：

```text
SAMATA_WEWORK_USER_NOTIFY_TARGET=gzxujun
SAMATA_WEWORK_USER_NOTIFY_BOT=ticlaw
```

- 更新用户管理说明，明确 `/user alias` 与 `/agent member` 应使用 canonical user id。

## 已实施改动清单

- `src/auth/rbac.ts`
  - 新增 `buildWeworkAutoUserId(raw)`，使用 `user-wework-<sha256前12位>` 作为未绑定企微用户的 canonical id。
  - 新增 `buildWeworkUserAliasId(raw)`，统一生成 `wework_user_<raw>` alias。
  - 新增 `resolveExternalUserWithStatus()`，在保留 `resolveExternalUser()` 兼容返回的同时，向 WeWork 会话返回 `created / aliasIds / rawUserId`。
  - WeWork identity 不再自动注册旧格式 `wework_<raw>`。
- `src/wework/session.ts`
  - `getSession()` 支持传入触发消息上下文和新用户创建回调。
  - 新 raw userid 首次创建 canonical user 时，向调用方返回创建事件。
- `src/wework/bot.ts`
  - 文本、图片、图文、文件、未知消息、slash command 均带上触发消息中的原始企微用户上下文。
  - 自动创建新用户后，通过企微主动消息通知 `gzxujun`。
  - 反馈卡片点击用户改用统一身份解析，避免继续写入 `wework_user_<raw>` 作为用户 ID。
  - 注册企微通知队列的连接 resolver。
- `src/wework/notification-queue.ts`
  - 改为通过 `setWeworkNotificationClientResolver()` 注入连接获取函数。
  - 保留既有队列、限速和 846607 退避逻辑。
- `.env.example`
  - 新增 `SAMATA_WEWORK_USER_NOTIFY_TARGET=gzxujun`。
  - 新增 `SAMATA_WEWORK_USER_NOTIFY_BOT=ticlaw`。
- `tests/unit/config/rbac.test.ts`
  - 覆盖 WeWork canonical hash ID、current alias-only、新用户无 agent 权限、重复解析不重复创建。
- `tests/unit/config/wework-session.test.ts`
  - 覆盖 session 新用户创建事件和原始消息上下文。
- `tests/unit/services/deliver.test.ts`、`tests/unit/plugins/registry-delivery.test.ts`
  - 更新为通知队列 resolver 注入模式。
- `scripts/migrate-wework-canonical-users.ts`
  - 新增生产 SQLite 企微用户 canonical 迁移脚本。
  - 默认 `--dry-run`，输出 canonical 用户、alias、agent_members 合并、历史引用更新计划。
  - 除 `users` 旧行外，也会从历史引用列与 `agent_members.user_id` 发现孤立企微 raw id，自动创建 `user-wework-<hash>` 并绑定 current alias。
  - `--apply` 时先备份 SQLite，再用事务执行迁移、删除旧用户，并对比迁移前后的 `PRAGMA foreign_key_check`，只允许迁移前已存在的历史 FK 异常继续存在。
- `package.json`、`package-lock.json`
  - 根包版本递增：`3.0.26 -> 3.0.27`。

## 生产库 Dry-Run 结果

执行命令：

```bash
npx tsx scripts/migrate-wework-canonical-users.ts --dry-run
```

结果摘要：

- 旧 `wework_* / wework_user_*` 用户：61。
- 将创建/更新 canonical 用户：38。
- 将创建/更新 current alias：41。
- 旧 `agent_members`：10。
- 合并后 `agent_members`：8。
- 历史引用更新：
  - `documents.created_by`: 15
  - `events.performed_by`: 142
  - `knowledge.created_by`: 41
  - `memory.created_by`: 14
  - `pricing_quotes.created_by`: 2
  - `skills.created_by`: 2
  - `todos.user_id`: 1
  - `answer_feedback.user_id`: 95
  - `answer_feedback.clicked_by_user_id`: 27
  - `scheduled_tasks.created_by`: 2
  - `telemetry_turn.user_id`: 973

许骏 dry-run 目标：

```text
user-gzxujun
  old:
    wework_gzxujun
    wework_user_gzxujun
    wework_user_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ
    wework_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ
  alias:
    wework_user_gzxujun
    wework_user_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ
  agent_members:
    ticlaw admin
    otcclaw admin
```

## 现有用户迁移原则

### 许骏

- 保留 canonical：`user-gzxujun`。
- 绑定 alias：
  - `wework_user_gzxujun`
  - `wework_user_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ`
- 迁移 ticlaw、otcclaw 的 `agent_members` 到 `user-gzxujun`。
- 删除或停止使用：
  - `wework_gzxujun`
  - `wework_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ`
  - 作为 `users.id` 存在的 `wework_user_*`

### 栾宜男、唐洋、刘航伸等

- 为每个自然人建立一个 canonical user。
- 将当前格式 `wework_user_<raw>` 作为 alias 绑定到该 canonical user。
- 不再保留旧格式 `wework_<raw>`。
- 若这些用户当前无 agent 权限，只迁移身份与历史引用，不自动授予权限。

### 其他未知 raw userid

- 若能确认自然人，按已知用户规则绑定到对应 canonical user。
- 若不能确认，保留自动创建的 `user-wework-<hash>`，等待管理员处理。
- 不自动合并同名用户，因为不查企微资料时姓名不具备唯一性。

## 数据迁移注意事项

- `agent_members` 需要合并重复权限行，优先保留最高权限 `admin`。
- 业务表中已引用旧 user id 的历史记录需要按风险分批处理：
  - 权限相关表优先迁移到 canonical user。
  - `events`、`knowledge`、`memory`、`documents`、`pricing_quotes`、`scheduled_tasks` 等有业务外键或历史含义的表，需要通过脚本迁移或在报表层做 alias 聚合。
  - `telemetry_turn` 与 `answer_feedback` 中的用户列也迁移为 canonical user id；原始企微 raw id 通过 `user_aliases` 保留映射。
- 删除旧 user 前必须确认没有外键引用阻塞，也不能误删用户产生的历史业务数据。
- 生产库迁移前已有 30 条非企微历史 FK 异常，主要来自飞书历史用户和 `knowledge_pending` 孤儿记录；本次脚本使用 FK baseline 对比，确保不引入新的 FK 异常。

## 生产库 Apply 结果

执行前已停止 `otcclaw` 主服务容器，仅保留 Langfuse 相关容器运行，避免旧运行时代码继续写入旧格式企微 ID。

第一次执行：

```bash
npx tsx scripts/migrate-wework-canonical-users.ts --apply
```

结果：

- 备份文件：`/opt/samata/data/backups/wework-canonical-users-20260709T004309Z/samata.db`。
- 旧 `wework_* / wework_user_*` 用户：61 -> 0。
- `agent_members` 旧企微 ID：10 -> 0。
- legacy alias：0。
- current alias：41。
- 迁移后发现 `answer_feedback.clicked_by_user_id` 仍有 1 条孤立 `wework_user_*`，原因是该 raw id 只存在于历史反馈点击人字段，没有对应旧 `users` 行。

补强脚本后第二次执行：

```bash
npx tsx scripts/migrate-wework-canonical-users.ts --apply
```

结果：

- 备份文件：`/opt/samata/data/backups/wework-canonical-users-20260709T004519Z/samata.db`。
- 孤立 raw id `wework_user_wofvtgBgAAPUILPs4XmECZQxE1r5xBLw` 迁移到 `user-wework-ab46f71ef456`。
- 新增 alias：`wework_user_wofvtgBgAAPUILPs4XmECZQxE1r5xBLw -> user-wework-ab46f71ef456`。

最终校验：

```text
old users: 0
old agent_members: 0
legacy aliases: 0
current wework aliases: 42
old references in checked user columns: 0
```

许骏最终状态：

```text
users:
  user-gzxujun / gzxujun / 许骏

user_aliases:
  wework_user_gzxujun -> user-gzxujun
  wework_user_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ -> user-gzxujun

agent_members:
  otcclaw + user-gzxujun + admin
  ticlaw  + user-gzxujun + admin
```

## 验证点

### 单元测试

- 新 raw userid 首次出现时创建 `user-wework-<hash>`，不创建 `wework_user_<raw>` 用户。
- 只插入 `wework_user_<raw>` alias，不插入旧格式 `wework_<raw>` alias。
- 已存在 alias 时返回对应 canonical user，不重复创建、不重复通知。
- 自动创建的新用户没有 `agent_members` 权限。
- 新用户通知目标默认为 `gzxujun`。
- 通知发送失败时不影响当前消息处理。

### 数据验证

```sql
SELECT id FROM users WHERE id LIKE 'wework_%' OR id LIKE 'wework_user_%';
SELECT alias_user_id, canonical_user_id FROM user_aliases WHERE alias_user_id LIKE 'wework_user_%';
SELECT agent_id, user_id, role FROM agent_members WHERE user_id LIKE 'wework_%' OR user_id LIKE 'wework_user_%';
```

目标结果：

- `users` 中不再新增 `wework_*` / `wework_user_*` 用户。
- `user_aliases` 中保留 `wework_user_*` alias。
- `agent_members` 中不再出现 `wework_*` / `wework_user_*`。

## 回滚与风险

- 最大风险是误合并自然人。由于本方案不查企微用户接口，自动合并只能依赖管理员确认。
- 自动创建用户不授予 agent 权限，可降低误接入风险。
- 若通知失败，系统仍会创建低权限用户；管理员可通过 `/user list` 发现 alias 数异常或待管理 `user-wework-*` 用户。
- 历史数据迁移应先 dry-run 输出变更清单，再执行写入。

## 验证命令

```bash
npm run test:unit -- tests/unit/config/rbac.test.ts tests/unit/config/wework-session.test.ts tests/unit/services/deliver.test.ts tests/unit/plugins/registry-delivery.test.ts
npx tsx scripts/migrate-wework-canonical-users.ts --dry-run
git diff --check -- docs/plan/2026-07-08_wework-user-management-canonical-id.md
npx tsc --noEmit
git status --short
```

## 验证结果

- `npm run test:unit -- tests/unit/config/rbac.test.ts tests/unit/config/wework-session.test.ts tests/unit/services/deliver.test.ts tests/unit/plugins/registry-delivery.test.ts`：通过，4 个测试文件、26 个测试。
- `npx tsx scripts/migrate-wework-canonical-users.ts --dry-run`：通过，迁移后 dry-run 为空计划，旧企微用户、旧 agent 权限、旧引用均为 0。
- `git diff --check -- .`：通过。
- `npx tsc --noEmit`：失败，剩余错误均在未改动文件 `src/services/mcp-manager.ts`，为既有 `ParsedLogyiDate | null` 与 `ParsedLogyiDate | undefined` 类型不匹配问题。

## Commit

- implementation commit hash：57f2730
