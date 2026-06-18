---
docModules:
  - platform
docTopics:
  platform: LLM JSON 输出修复
canonicalDocs:
  - /platform/common-tools
status: implemented
---

# 截断 JSON 对象修复

## 背景

运行日志中出现 workspace 摘要 JSON 解析失败，典型输入是模型输出到一半的对象字符串，例如只包含开头 `{ "summary": "..."`，导致 `parseLLMJsonObject` 只能抛错，摘要更新为空或残缺。

## 决策

- 保持现有 `parseLLMJsonObject` 入口不变，避免影响调用方。
- 在正常 `JSON.parse` 失败后，对截断对象做最小修复：补齐未闭合字符串、对象和数组闭合符，并移除尾逗号。
- 仅在修复结果可被 `JSON.parse` 验证时返回，否则继续抛出明确错误，避免吞掉真实脏数据。
- 不修改 Samata 运行时 memory 数据库，不写入 `data/samata.db` 的 `memory` 表。

## 改动清单

- `src/utils/json-repair.ts`
  - 放宽对象截取逻辑，允许缺少最后一个 `}` 的截断对象进入修复流程。
  - 在对象解析前移除尾逗号。
  - 新增 `repairTruncatedJsonObject`，按栈补齐 `{`、`[` 对应闭合符，并处理未闭合字符串。

## 验证命令

已执行：

```bash
npx tsc --noEmit
node --import tsx/esm - <<'NODE'
import { parseLLMJsonObject } from './src/utils/json-repair.ts';
const cases = [
  ['valid', '{"summary":"ok","items":[1,2]}'],
  ['trailing commas', '{"summary":"ok",}'],
  ['truncated object', '{"summary":"修改TRS合约不自动重跑估值，仅标记检查失败'],
  ['nested truncated', '{"summary":"ok","items":[{"a":1}'],
];
for (const [name, input] of cases) {
  const out = parseLLMJsonObject(input);
  console.log(name, JSON.stringify(out));
}
NODE
git diff --check -- src/utils/json-repair.ts docs/plan/2026-06-18_json-repair-truncated-object.md
```

结果：

- TypeScript 类型检查通过。
- `git diff --check` 通过。
- 有效 JSON、尾逗号、截断 object、嵌套截断 object 均可解析。

## 构建与发布

本次改动影响 Samata 运行时代码，需要重新构建 Samata Docker image 并重启容器。不涉及依赖变更、插件构建产物或数据库迁移。

## Commit Hash

- 实现提交：`d7315d3d4541b58a265729bdd721ec62cb30a48f`
- 留档补充：`de7f1f89b6db29901f33b0a397868390b21ba5bb`。
