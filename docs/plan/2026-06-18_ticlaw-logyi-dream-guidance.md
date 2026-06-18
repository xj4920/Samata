---
docModules:
  - platform
docTopics:
  platform: Agent Dream 运行经验
canonicalDocs:
  - /platform/common-tools
status: implemented
---

# ticlaw LogYi Dream 使用规则沉淀

## 背景

排查 `ticlaw` 调用 LogYi MCP 的日志后确认，失败主要来自两类场景：查询窗口超过平台限制，以及宽时间窗同步查询触发 MCP 请求超时。现有 `ticlaw` Dream 已有日志与代码并行排查经验，但缺少查询窗口、同步/异步选择、分片和输出压缩的明确规则。

## 决策

- 将 LogYi 查询窗口规则写为不超过 14天。
- 宽时间窗和复杂 SPL 优先使用 `logyi_submit_search` + `logyi_fetch_search`，同步 `search_sheets` 仅用于小范围明细查询。
- 接近两周的数据先用 `time_slice_minutes` 分片，并以 `count` 或 `timeline` 定位命中窗口。
- 默认压缩输出，只有需要完整 JSON 原文时才开启 `include_raw_message:true`。
- 通过新增 dated Dream 文件沉淀经验，保留历史 Dream 文件用于追溯。

## 改动清单

- 新增 `data/dreams/ticlaw/2026-06-18.md`（ignored，本机运行数据，不纳入本次普通 git 提交）
  - 增加 `LogYi MCP 查询策略（同步/异步、分片与输出压缩）`。
  - 合并保留日志与代码并行排查、`search_sheets` 降级互补、代码检索、知识库退出和图片输出等常用经验。
- 新增 `docs/plan/2026-06-18_ticlaw-logyi-dream-guidance.md`
  - 记录背景、决策、改动范围、验证命令和提交信息。

## 验证命令

```bash
node --import tsx/esm - <<'NODE'
import { validateDream, loadDreamFile } from './src/services/dream-analyze.ts';
import fs from 'node:fs';
const file = 'data/dreams/ticlaw/2026-06-18.md';
const content = fs.readFileSync(file, 'utf8');
console.log(validateDream(content, { strictSections: true }));
console.log(loadDreamFile('ticlaw').startsWith(content.trim()));
NODE

node --input-type=module - <<'NODE'
import fs from 'node:fs';
const targets = [
  'data/dreams/ticlaw/2026-06-18.md',
  'docs/plan/2026-06-18_ticlaw-logyi-dream-guidance.md',
];
const oldTerms = [`${10 + 5}天`, `${10 + 5} 天`];
const hits = [];
for (const file of targets) {
  const text = fs.readFileSync(file, 'utf8');
  for (const term of oldTerms) {
    if (text.includes(term)) hits.push(`${file}: ${term}`);
  }
}
if (hits.length) {
  console.error(hits.join('\n'));
  process.exit(1);
}
console.log('old window terms not found');
NODE
git diff --check -- data/dreams/ticlaw/2026-06-18.md docs/plan/2026-06-18_ticlaw-logyi-dream-guidance.md
```

## 验证结果

- `validateDream(content, { strictSections: true })` 通过，`loadDreamFile('ticlaw')` 已读取 `2026-06-18.md`。
- 旧窗口表述脚本检查通过，新规则使用 14天。
- `git diff --check` 通过。
- 注意：`data/dreams/**` 当前被 `.gitignore` 的 `data*` 规则忽略，如需提交 Dream 文件，提交时需要显式 `git add -f data/dreams/ticlaw/2026-06-18.md`。

## Commit Hash

- 留档提交：`de7f1f89b6db29901f33b0a397868390b21ba5bb`。

## 构建与重启判断

该改动仅涉及 Dream 文本和计划文档，不影响 TypeScript 运行时代码、Docker image、插件构建产物、依赖或数据库迁移；不需要重新构建镜像或重启服务。
