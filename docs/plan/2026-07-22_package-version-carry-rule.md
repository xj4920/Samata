---
docModules:
  - platform
docTopics:
  platform: 工程协作规范
canonicalDocs:
  - /platform/index
status: implemented
---

# Package 版本进位规则修正

## 背景

Samata 原有协作规则要求每次代码提交前递增版本，但没有限制三段版本号各段的范围，
导致版本从 `3.0.20` 继续增长到 `3.0.35`。用户确认 patch 位到 20 后进位 minor，minor
位到 9 后进位 major，因此需要修正当前版本并固化长期规则。

## 核心决策

- 版本号使用 `A.B.C` 三段格式。
- 当 `C < 20` 时，下一 patch 版本为 `A.B.(C+1)`。
- 当 `C = 20` 时，下一版本为 `A.(B+1).0`。
- 当 `B = 9` 且 `C = 20` 时，下一版本为 `(A+1).0.0`。
- 当前非法版本 `3.0.35` 不按历史提交次数重新折算，直接修正为新规则下的合法起点
  `3.1.0`。
- 规则写入项目 `AGENTS.md`，不写入 Samata 运行时 memory 数据库。

## 改动清单与数据流

- `AGENTS.md`：补充三段版本范围、进位条件与示例。
- `package.json`：版本修正为 `3.1.0`。
- `package-lock.json`：同步顶层与根包版本为 `3.1.0`。
- `docs/.vitepress/plan-index.generated.ts`：同步本 PLAN 索引。

```text
代码提交需要递增版本
  -> 读取当前 A.B.C
  -> C 未到 20：递增 C
  -> C 已到 20：C 归零并递增 B
  -> B 已到 9：B/C 归零并递增 A
  -> 同步 package.json 与 package-lock.json
```

## 验证命令

- 解析 `package.json` 与 `package-lock.json`，检查三个根版本字段一致。
- `npm run docs:build`
- `git diff --check`
- `npm run docker:samata:build`

## 验证结果

- 版本一致性检查通过：`package.json`、`package-lock.json` 顶层版本和
  `packages[""]` 根包版本均为 `3.1.0`，两个 JSON 文件可正常解析。
- 进位示例检查通过：`3.0.19 -> 3.0.20`、`3.0.20 -> 3.1.0`、
  `3.9.20 -> 4.0.0`。
- `npm run docs:build` 通过并更新 PLAN 索引；同步脚本仍报告仓库既有历史 PLAN 的
  frontmatter / canonical target 问题，本次 PLAN 未被点名，VitePress 构建成功。
- `npm run docker:samata:build` 通过，生成镜像
  `local/titans/otcclaw:v3.1.0-0722173942970`，image ID
  `sha256:0c35cb928e65a8655752a4e23c12610fa78519f2fca412facc6854f2e7843224`。
- 当前运行容器未重启，仍使用远端镜像 `v3.0.34-0722102442931`，状态为 healthy。

## 构建与运行影响

- 不修改生产运行时代码、依赖集合或数据库 schema。
- Package 版本影响 Docker image tag，因此重新构建 `3.1.0` 对应镜像。
- 本次不执行数据库迁移，不主动重启服务。

## Commit Hash

- 实现提交：待用户确认提交后回填。
