---
docModules:
  - platform
docTopics:
  platform: 工程协作规范
canonicalDocs:
  - /platform/index
status: implemented
---

# Package Version 提交前递增规则

## 背景

用户要求将长期协作规则写入当前项目 agent 指令文件：每次提交代码时，根目录 `package.json` 的 `version` 需要向上递增。

在 `Agent loop 支持用户补充信息中断并重启` 实现提交后，发现当时没有递增 `package.json` 版本。原因是本规则仍处于未跟踪文件中，尚未纳入仓库生效。本次补充提交需要同时完成规则入库与版本修正。

## 决策

- 在项目根目录新增 `AGENTS.md`，作为当前仓库的 Agent 协作规则入口。
- 规则限定为“提交代码前递增版本号”，避免把一次性运行状态写入 Samata 应用运行时 memory 数据库。
- 若存在 `package-lock.json`，版本变更必须同步锁文件中的根包版本信息。
- 未特别说明版本级别时，默认递增 patch 版本。

## 改动清单

- `AGENTS.md`
  - 新增提交版本号规则。
- `package.json`
  - 将版本从 `3.0.13` 递增到 `3.0.14`。
- `package-lock.json`
  - 同步顶层 `version` 与根包 `packages[""].version` 为 `3.0.14`。
- `docs/plan/2026-06-30_package-version-before-code-commit.md`
  - 记录本次背景、决策、版本修正、验证与提交状态。
- `docs/.vitepress/plan-index.generated.ts`
  - 同步新增本 plan 在平台模块中的索引。

## 验证命令

已执行：

```text
npm version patch --no-git-tag-version
npm run docs:plan-sync
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); console.log(JSON.stringify({package:p.version, lock:l.version, root:l.packages[''].version}, null, 2))"
git diff --check
npm run docs:plan-sync -- --check
git status --short
```

## 验证结果

- `npm version patch --no-git-tag-version`：通过，输出 `v3.0.14`。
- `npm run docs:plan-sync`：通过，已更新 `docs/.vitepress/plan-index.generated.ts`；输出仍包含既有历史 plan frontmatter / canonicalDocs warning/error，本次新增 plan 未被点名。
- 版本一致性检查：通过，`package.json`、`package-lock.json` 顶层版本、`package-lock.json packages[""].version` 均为 `3.0.14`。
- `git diff --check`：通过。
- `npm run docs:plan-sync -- --check`：索引已是最新；命令仍因历史 plan frontmatter / canonicalDocs 既有问题退出 1。
- `npm run docker:samata:build`：通过。

## Commit Hash

- 待提交。

## 构建与运行影响

- 本次未修改运行时代码、依赖集合或数据库迁移。
- 由于 `package.json` 版本会影响 Samata Docker image tag，已重新执行 `npm run docker:samata:build`。
- 构建成功，生成 `samata:3.0.14-5746bfbdae2e-dirty-20260630110513`。
- 已刷新 `samata:3.0.14` 与 `samata:latest`。
- 本次提交并推送后执行 `npm run docker:samata:up`，重建并重启正在运行的 Samata 容器。
