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

2026-06-05 通过 `npm run cli` 连接 Docker 中的 Samata 后，已验证普通 `user` 切换到 `otcclaw` 可以计算 2026-06-04 常速换手，且计算从已入库数据返回，不触发同步。需要把这个权限预期固化为 unit test，避免后续配置回归。

## 决策

- 普通用户开放 `calc_normal_trading_annual_turnover`。
- 普通用户继续禁止 `sync_normal_trading_summary`。
- 已部署库中可能已经运行过旧 migration，因此新增幂等 migration，从 `otcclaw.user_tools_list` 移除 `calc_normal_trading_annual_turnover`。
- 插件侧负责保证普通用户调用 calc 时不触发同步。
- 新增聚焦单测，明确普通 `otcclaw` 可以使用常速换手计算和只读查询，但不能使用 NormalTrading / FastTrading 同步工具。

## 改动清单

- `src/db/schema.ts`
  - 从 NormalTrading 工具授权的写工具列表移除 `calc_normal_trading_annual_turnover`。
  - 新增 `otcclaw-unblock-normal-trading-turnover-calc-v1` migration，修正既有数据库。
- `tests/unit/config/agent-config.test.ts`
  - 断言 otcclaw 普通用户包含 `calc_normal_trading_annual_turnover`。
  - 继续断言普通用户不包含 `sync_normal_trading_summary`。
  - 新增独立用例 `otcclaw member can calculate normal trading turnover without sync tools`，将 CLI 验证结果固化为权限回归测试。

## 验证命令

```text
npm test -- tests/unit/config/agent-config.test.ts
npm run test:unit -- tests/unit/config/agent-config.test.ts
npm run docs:plan-sync
git diff --check -- src/db/schema.ts tests/unit/config/agent-config.test.ts docs/plan
```

## 验证结果

已通过：

```text
npm test -- tests/unit/config/agent-config.test.ts
# Test Files 1 passed (1), Tests 17 passed (17)

npm run test:unit -- tests/unit/config/agent-config.test.ts
# Test Files 1 passed (1), Tests 18 passed (18)

npm run docs:plan-sync
# updated docs/.vitepress/plan-index.generated.ts
# emitted existing warnings/errors for unrelated older plan frontmatter

git diff --check -- src/db/schema.ts tests/unit/config/agent-config.test.ts docs/plan docs/.vitepress
# passed

git diff --check -- tests/unit/config/agent-config.test.ts docs/plan/2026-06-05_otcclaw-member-normal-turnover.md
# passed
```

## Commit Hash

40d20355e6182875b71f22e9c6d5c993d7249bce

本次 CLI 验证固化提交：待提交后补充。
