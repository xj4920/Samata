---
docModules:
  - platform
docTopics:
  platform: 部署与本地产物
canonicalDocs:
  - /platform/deployment
status: planned
---

# 忽略 docs/report 本地汇报产物

## 背景

制作 OTCCLAW 总经理汇报材料时，本地会在 `docs/report/` 下生成 HTML、PPT、截图或其他临时汇报产物。这些文件属于个人准备材料或本地生成产物，不应默认进入 Git 状态。

当前 `.gitignore` 已忽略 `docs/.vitepress/dist/`、`docs/.vitepress/cache/` 等文档构建产物，但未显式忽略 `docs/report/`，导致该目录显示为未跟踪文件。

## 决策

- 在 `.gitignore` 中新增 `docs/report/`。
- 不删除 `docs/report/` 下的本地文件。
- 按最终提交范围，一并纳入同期遗留的汇报计划、生成索引更新和已删除旧版 PDF。
- 本次只记录忽略规则与计划留档，不修改运行时配置、数据库、依赖或构建脚本。

## 改动清单

- `.gitignore`
  - 新增 `docs/report/` 忽略规则。
- `docs/plan/2026-07-04_ignore-docs-report.md`
  - 记录背景、决策、改动清单、验证命令、commit hash 占位和构建影响。
- `docs/.vitepress/plan-index.generated.ts`
  - 由 `npm run docs:plan-sync` 自动同步新增 plan 索引。
- `docs/OTCClaw 衍语 — 产品介绍-V2.pdf`
  - 移除旧版产品介绍 PDF，避免仓库继续保留过期二进制材料。

## 验证命令

```text
git check-ignore -v docs/report/test.txt
npm run docs:plan-sync
git diff --check -- .gitignore docs/plan/2026-07-04_ignore-docs-report.md docs/.vitepress/plan-index.generated.ts
```

## 验证结果

已执行：

```text
git check-ignore -v docs/report/test.txt
# .gitignore:52:docs/report/ docs/report/test.txt

npm run docs:plan-sync
# updated docs/.vitepress/plan-index.generated.ts
# 脚本输出了历史 plan frontmatter 既有 warning/error，本次新增 plan 未被点名；命令退出码为 0。

git diff --check -- .gitignore docs/plan/2026-07-04_ignore-docs-report.md docs/.vitepress/plan-index.generated.ts
# passed
```

## Commit Hash

待提交。

## 构建与运行影响

- 仅修改 Git 忽略规则、计划文档和文档索引。
- 不影响运行时构建产物、Docker image、插件构建产物、依赖或数据库 migration。
- 不需要重新构建或重启 Samata。
