---
docModules:
  - permissions
  - plugins
docTopics:
  permissions: Agent 权限
  plugins: 插件接入
canonicalDocs:
  - /permissions/tool-access
status: implemented
---

# otcclaw 普通用户常速换手计算权限

## 背景

普通用户不应触发 NormalTrading SFTP 同步，但需要使用已入库数据计算北向常速多头、空头年化换手率。当前 `otcclaw` 的普通用户 blocklist 同时屏蔽了 `sync_normal_trading_summary` 与 `calc_normal_trading_annual_turnover`，导致普通用户不能计算 turnover。

## 决策

- 普通用户开放 `calc_normal_trading_annual_turnover`。
- 普通用户继续禁止 `sync_normal_trading_summary`。
- 已部署库中可能已经运行过旧 migration，因此新增幂等 migration，从 `otcclaw.user_tools_list` 移除 `calc_normal_trading_annual_turnover`。
- 插件侧负责保证普通用户调用 calc 时不触发同步。

## 改动清单

- `src/db/schema.ts`
  - 从 NormalTrading 工具授权的写工具列表移除 `calc_normal_trading_annual_turnover`。
  - 新增 `otcclaw-unblock-normal-trading-turnover-calc-v1` migration，修正既有数据库。
- `tests/unit/config/agent-config.test.ts`
  - 断言 otcclaw 普通用户包含 `calc_normal_trading_annual_turnover`。
  - 继续断言普通用户不包含 `sync_normal_trading_summary`。

## 验证命令

```text
npm test -- tests/unit/config/agent-config.test.ts
npm run docs:plan-sync
git diff --check -- src/db/schema.ts tests/unit/config/agent-config.test.ts docs/plan
```

## 验证结果

已通过：

```text
npm test -- tests/unit/config/agent-config.test.ts
# Test Files 1 passed (1), Tests 17 passed (17)

npm run docs:plan-sync
# updated docs/.vitepress/plan-index.generated.ts
# emitted existing warnings/errors for unrelated older plan frontmatter

git diff --check -- src/db/schema.ts tests/unit/config/agent-config.test.ts docs/plan docs/.vitepress
# passed
```

## Commit Hash

待回填。
