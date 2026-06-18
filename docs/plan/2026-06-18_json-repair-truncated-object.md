# JSON 对象截断修复提交

## 背景

`src/utils/json-repair.ts` 用于修复和解析 LLM 输出的 JSON。已有逻辑支持数组截断修复，但对象解析在缺少末尾 `}` 时会直接失败；同时对象内部尾随逗号也需要与数组解析保持一致处理。

## 决策

- `parseLLMJsonObject` 在找到 `{` 后允许对象末尾缺失 `}`，保留从首个 `{` 开始的文本进入修复流程。
- 对象解析前统一清理 `,]` 与 `,}` 这类尾随逗号。
- 新增 `repairTruncatedJsonObject`，基于栈补齐未闭合的 `}` / `]`，并在字符串截断时补齐闭合引号。
- 修复失败时抛出明确错误，避免静默返回错误数据。

## 改动清单

- `src/utils/json-repair.ts`
  - 放宽对象截取逻辑，支持缺失末尾 `}` 的截断对象。
  - 对对象解析加入尾随逗号清理。
  - 新增对象截断修复函数。

## 验证命令

计划执行：

```bash
node --import tsx/esm - <<'NODE'
import { parseLLMJsonObject } from './src/utils/json-repair.ts';
console.log(parseLLMJsonObject('{"ok":true, "items":[1,2,'));
NODE
git diff --check -- src/utils/json-repair.ts docs/plan/2026-06-18_json-repair-truncated-object.md
```

## 构建影响

本次仅修改 TypeScript 工具函数和文档留档，不涉及 Dockerfile、依赖、数据库迁移或插件构建产物。运行中的 Docker 服务未重建。

## Commit

- implementation commit hash: `d7315d3`
