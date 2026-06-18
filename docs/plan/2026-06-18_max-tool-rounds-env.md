---
docModules:
  - platform
docTopics:
  platform: 运行时工具轮次配置
canonicalDocs:
  - /platform/common-tools
status: implemented
---

# MAX_TOOL_ROUNDS 运行配置放宽

## 背景

`ticlaw` 在复杂生产日志排查中会同时使用 LogYi、代码检索、知识库和结构化输出工具。当前运行环境 `.env` 中 `MAX_TOOL_ROUNDS=30`，在宽日志查询、异步轮询和代码并行分析场景下容易提前触达工具轮次上限。

## 决策

- 将本机运行环境 `.env` 中的 `MAX_TOOL_ROUNDS` 从 `30` 放宽到 `100`。
- 仅更新 `.env`，不修改 `.env.example` 的默认示例值。
- `.env` 是本机忽略配置，不纳入 git 提交；留档文档记录该运行配置变更和重启要求。

## 改动清单

- `.env`（ignored，本机运行配置，不纳入 git 提交）
  - `MAX_TOOL_ROUNDS=30` 改为 `MAX_TOOL_ROUNDS=100`。
  - 去除原行尾空格。
- `docs/plan/2026-06-18_max-tool-rounds-env.md`
  - 记录背景、决策、验证命令、提交状态和构建重启判断。

## 验证命令

```bash
rg -n "^MAX_TOOL_ROUNDS=" .env

node --input-type=module - <<'NODE'
import fs from 'node:fs';
const line = fs.readFileSync('.env', 'utf8')
  .split(/\r?\n/)
  .find(line => line.startsWith('MAX_TOOL_ROUNDS='));
const value = Number(line?.split('=')[1]?.trim());
if (value !== 100) {
  console.error(`MAX_TOOL_ROUNDS expected 100, got ${line}`);
  process.exit(1);
}
console.log(`MAX_TOOL_ROUNDS=${value}`);
NODE

git diff --check -- docs/plan/2026-06-18_max-tool-rounds-env.md
git status --short --ignored=matching -- .env docs/plan/2026-06-18_max-tool-rounds-env.md
```

## 验证结果

- `rg -n "^MAX_TOOL_ROUNDS=" .env` 确认当前值为 `MAX_TOOL_ROUNDS=100`。
- Node 脚本解析 `.env` 通过，输出 `MAX_TOOL_ROUNDS=100`。
- `git diff --check` 通过。
- `git status --short --ignored=matching -- .env docs/plan/2026-06-18_max-tool-rounds-env.md` 确认 `.env` 为 ignored，本留档文档为未跟踪待提交文件。

## Commit Hash

- 留档提交：`de7f1f89b6db29901f33b0a397868390b21ba5bb`。

## 构建与重启判断

`MAX_TOOL_ROUNDS` 在 Samata 进程启动时读取。该变更不涉及 TypeScript 代码、依赖、数据库迁移、Docker image 或插件构建产物；不需要重新构建镜像。

- 已执行 `docker compose restart samata`。
- 已确认容器内 `/app/samata/.env` 为 `MAX_TOOL_ROUNDS=100`。
- 已确认 `samata` 容器恢复为 `healthy`。
