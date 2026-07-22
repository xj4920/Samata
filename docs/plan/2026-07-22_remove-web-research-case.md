---
docModules:
  - platform
docTopics:
  platform: 场景回归评测
canonicalDocs:
  - /platform/scenario-regression
status: implemented
---

# Web 调研退出场景回归

## 背景

首批场景回归为了覆盖全部 taxonomy，从较早时间窗口补充了“产业园区客群公开资料调研”
Case。用户在查看当前 `eval:full` 清单后，确认 Web 调研不再纳入 active regression。

## 核心决策

- 将 `smoke-web-industry-park-v1` 从 `approved` 调整为 `deprecated`。
- 不物理删除 Case，保留问题、不可逆来源 hash、脱敏 fixture 和历史验证记录用于审计。
- 不删除 `web_research` taxonomy，日志候选仍可继续分类到该场景，未来也可重新设计
  Case。
- Smoke 和 Full 只加载 `approved`，因此无需修改运行器即可停止执行该 Case。

## 影响模块与数据流

```text
evals/cases/web_research/*.yaml
  -> status: deprecated
  -> approved loader 过滤
  -> Smoke 不再选择 web_research
  -> Full 不再执行 web_research
```

- Active case 从 12 个降为 11 个。
- Smoke 从 9 次降为 8 次。
- Full 从 36 次降为 33 次。

## 验证命令

- `npm run eval:validate`
- `npm run eval:smoke`
- `npm run eval:full`
- `npm run eval:self-test`
- `npx tsc --noEmit`
- `npm run docs:build`
- `git diff --check`

## 验证结果

- Case schema 校验通过：文件总数 12，`approved` 11，`deprecated` 1；Web 调研的
  approved 数量为 0。
- Smoke 通过：8/8 Case、8/8 repetitions，Run ID
  `f26cb906-4a4b-48de-9e96-df453fe74e1c`；报告不包含 `web_research`。
- Full 通过：11/11 Case、33/33 repetitions，Run ID
  `78bfc611-8467-4073-b9d5-6507f6c2da4c`；approved case set hash 为
  `15474802d3da35bf31153098f43ecb532cc5d3d52c1c74be69972f292500a65d`，报告不包含
  `web_research`。
- Full 耗时范围 2804～16292 ms，中位数 4802 ms，非正耗时为 0。
- `eval:self-test` 通过：8 个测试文件、18 个测试；`npx tsc --noEmit` 通过。
- `npm run docs:build` 通过并刷新 PLAN 索引；同步脚本仍报告仓库既有历史 PLAN 的
  frontmatter / canonical target 问题，本次 PLAN 未被点名，VitePress 构建成功。

## 构建与运行影响

- 仅调整评测数据状态和文档，不修改生产 Agent、工具、依赖、数据库或运行时产物。
- 不需要构建 Docker image、执行数据库迁移或重启服务。

## Commit Hash

- 实现提交：待用户确认提交后回填。
