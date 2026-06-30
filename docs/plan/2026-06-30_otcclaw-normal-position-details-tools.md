---
docModules:
  - plugins
  - permissions
docTopics:
  plugins: 插件接入
  permissions: Agent 权限
canonicalDocs:
  - /plugins/bind-to-agent
  - /permissions/tool-access
status: implemented
---

# otcclaw 常速持仓明细工具注册

## 背景

`otcclaw` 需要注册常速持仓明细相关的两个 agent-bound 插件工具：

- `sync_normal_trading_position_details`
- `query_normal_trading_position_details_csv`

Samata 当前工具可见性由运行时 `agents.tools_list` 与 `getAgentTools()` 动态决定，工具 schema 由插件定义传给 LLM；不应为了新增工具继续修改 `config/agents/otcclaw.md`。

## 决策

- 不修改 `config/agents/otcclaw.md`。
- 在 production bootstrap 示例中补齐 `otcclaw.toolsList`，让新环境能按配置创建/更新工具绑定。
- `sync_normal_trading_position_details` 是同步类工具，加入普通成员 blocklist。
- `query_normal_trading_position_details_csv` 是只读 CSV 查询工具，普通成员可用。
- 在 README 中补充 Agent 加 Tool SOP，生产运行库由管理员按 SOP 执行绑定脚本，本次不直接修改 `data/samata.db`。

## 改动清单

- `config/production-bootstrap.example.json`
  - 为 `otcclaw.toolsList` 增加两个常速持仓明细工具。
  - 为 `otcclaw.userToolsList` 增加同步工具 blocklist。
- `tests/helpers/unit-harness.ts`
  - 测试插件 stub 增加两个工具名。
  - 同步工具沿用管理员授权校验。
- `tests/unit/config/agent-config.test.ts`
  - 回归断言管理员可见两个工具。
  - 回归断言普通成员可见 CSV 查询工具、不可见同步工具。
- `README.md`
  - 新增 Agent 加 Tool SOP，说明 dry-run、apply、member blocklist 与验证步骤。
- `package.json` / `package-lock.json`
  - 按提交规则将版本从 `3.0.15` 递增到 `3.0.16`。

## 验证命令

```text
npm version patch --no-git-tag-version
npm test -- tests/unit/config/agent-config.test.ts
npm run docs:plan-sync
git diff --check
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); console.log(JSON.stringify({package:p.version, lock:l.version, root:l.packages[''].version}, null, 2))"
```

## 验证结果

已执行：

```text
npm version patch --no-git-tag-version
# v3.0.16

npm test -- tests/unit/config/agent-config.test.ts
# Test Files 1 passed (1), Tests 19 passed (19)

npm run docs:plan-sync
# docs/.vitepress/plan-index.generated.ts is up to date
# 仍输出历史 plan frontmatter / canonicalDocs 既有 warning/error，本次新增 plan 未被点名

git diff --check
# passed

node -e "const p=require('./package.json'); const l=require('./package-lock.json'); console.log(JSON.stringify({package:p.version, lock:l.version, root:l.packages[''].version}, null, 2))"
# {"package":"3.0.16","lock":"3.0.16","root":"3.0.16"}
```

## Commit Hash

待提交。

## 构建与运行影响

- 本次不修改运行时主路径、依赖、数据库 migration 或 Dockerfile。
- 本次不直接修改运行库 `data/samata.db`。
- 由于提交前递增了 package version，提交后需要重新构建 Samata Docker image，刷新版本 tag。
