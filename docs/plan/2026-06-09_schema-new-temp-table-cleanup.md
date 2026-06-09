---
docModules:
  - platform
docTopics:
  platform: 数据库初始化
status: implemented
canonicalDocs:
  - /platform/deployment
---

# Schema 临时重建表清理

## 背景

`src/db/schema.ts` 中保留了多段历史 SQLite rebuild 迁移，采用 `*_new` 临时表完成建表、拷贝、删除旧表、重命名。这些迁移已经不再适合作为长期 schema 初始化代码保留；当前运行库和插件库也未发现残留的 `*_new` 表。

本次按确认计划清理 `src/db/schema.ts` 中 `*_new` 临时重建表相关代码，不修改 `data/samata.db`，不写入运行时 memory 数据。

## 决策

- 删除历史 `*_new` 临时表 rebuild 迁移块，不再为很老的数据库保留自动重建兼容路径。
- 保留不涉及 `*_new` 的基础建表、`ALTER TABLE ADD COLUMN` 和数据清理迁移。
- 将已依赖的目标表结构折叠进基础建表定义，避免新库初始化少列或少约束。
- `drop-agents-system-prompt-column` 仅保留 `ALTER TABLE agents DROP COLUMN system_prompt` 路径，不再使用 rebuild fallback。
- 不执行任何针对当前运行库的 schema 改写命令。

## 改动清单

- `src/db/schema.ts`
  - 删除 `normalize-user-aliases-schema-v1`、`scheduled-tasks-allow-tool-call`、`scheduled-tasks-allow-agent-chat-v1`。
  - 删除 `rebuild-skills-drop-name-unique`、`agent-assignments-add-app-id`、`agents-allow-standard-tools-mode`。
  - 删除 `fix-documents-agent-fk-cascade`。
  - 删除 `drop-agents-system-prompt-column` 中的 `agents_new` fallback rebuild。
  - 基础 `agent_assignments` 表定义补齐 `app_id` 和 `UNIQUE(channel, app_id, target_id)`。
  - 基础 `documents` 表定义补齐当前稳定列，并将 `agent_id` 外键定义为 `ON DELETE CASCADE`。

## 验证命令

已执行：

```text
rg -n "\b[A-Za-z0-9_]+_new\b" src/db/schema.ts
npm test -- tests/unit/schema/schema.test.ts tests/unit/schema/fs-migration-guard.test.ts
npm test -- tests/unit/tools/schedule.test.ts tests/unit/services/task-scheduler-agent-chat.test.ts
node -e "const fs=require('fs');const path=require('path');const Database=require('better-sqlite3');const files=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()){if(!p.includes('/postgres')) walk(p);}else if(/\.(db|sqlite|sqlite3)$/.test(e.name)) files.push(p)}}walk('data');const hits=[];for(const f of files){const db=new Database(f,{readonly:true,fileMustExist:true});const rows=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '*new' ORDER BY name\").all();if(rows.length) hits.push({file:f,tables:rows.map(r=>r.name)});db.close()}console.log(JSON.stringify({scanned:files.length,hits},null,2))"
git diff --check
npm run docs:plan-sync
npm run docker:samata:build
```

## 验证结果

- `rg -n "\b[A-Za-z0-9_]+_new\b" src/db/schema.ts` 无匹配，确认 `schema.ts` 中不再包含 `*_new` 标识。
- schema 单测通过：2 个测试文件，38 个测试。
- 定时任务相关单测通过：2 个测试文件，22 个测试。
- 只读扫描 `data/` 下 16 个 SQLite 数据库，未发现 `*_new` 表残留。
- `git diff --check` 通过。
- `npm run docs:plan-sync` 通过并更新 `docs/.vitepress/plan-index.generated.ts`；输出仍包含既有历史 plan 的 frontmatter 警告/错误，本次新增文件未被点名。
- `npm run docker:samata:build` 已尝试执行，但 Docker 拉取 `node:22-bookworm-slim` 元数据时走到不可用代理 `127.0.0.1:7890`，报 `proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused`，镜像未完成重建。

## Commit Hash

- 实现提交：`d06884607ac7d6e083f5756da51809e90ec7bf28`
- 留档回填提交：本段所在提交。

## 构建与运行影响

- 影响启动期 schema 初始化源码；部署到运行环境后需要重新构建或发布 runtime / Docker image，并重启服务后生效。
- 已尝试执行 `npm run docker:samata:build`，但因 Docker 代理配置不可用导致基础镜像元数据拉取失败；当前未重启服务。
- 本次不新增 npm 依赖。
- 本次不修改当前 `data/samata.db`。当前运行库如仍缺少历史 CHECK 约束升级，删除 rebuild 迁移后不会再由启动流程自动补齐。
