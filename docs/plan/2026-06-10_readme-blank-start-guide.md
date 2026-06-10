---
docModules:
  - platform
docTopics:
  platform: 空白项目启动
status: implemented
canonicalDocs:
  - /platform/deployment
---

# README 空白项目启动说明

## 背景

schema seed 清理后，空白数据库启动只会创建最小平台基线，不再自动 seed 业务 agent、企微 bot、tools 与成员权限。README 仍保留旧 agent 示例，缺少新 clone / 空 DB / 生产 bootstrap 的从零启动流程说明。

## 决策

- 将空白项目启动流程直接写入 `README.md` 的快速开始区域，作为新用户最容易看到的入口。
- README 明确默认自举只包含 `admin` agent，`ticlaw` / `otcclaw` 通过本地 production bootstrap 配置创建。
- README 说明 `admin` agent 不写入 `config/production-bootstrap.local.json`，但 admin 企微 bot 仍可通过 bootstrap 绑定。
- README 补充 Docker 空白部署、bootstrap dry-run/apply、企微 secret 管理、文档导入 agent 参数化和 Docker daemon 代理常见问题。

## 改动清单

- `README.md`
  - 替换旧 agent 示例表，移除历史业务 agent。
  - 新增“空白项目启动”小节，覆盖本地开发、生产 bootstrap、Docker 部署与文档导入。
  - 将“创建自定义 Agent（以 Moss 为例）”改为“配置生产 Agent（以 ticlaw 为例）”，强调生产 agent 通过 bootstrap 本地配置收敛。
  - 补充 production bootstrap 本地配置和 secret 不提交规则。
  - 将项目结构中的 DB 描述改为 DDL、自举与 Umzug migrations。

## 验证命令

已执行：

```text
npm run docs:plan-sync
git diff --check
rg -n "alter-ego|doctor|tutor|potato|falcon|\\bman\\b" README.md
rg -n "Moss|moss" README.md
npm run check-readme
```

## 验证结果

- `npm run docs:plan-sync` 通过并更新 `docs/.vitepress/plan-index.generated.ts`；输出仍有既有历史 plan 缺少 frontmatter 的 warning/error，本次新增文件未被点名。
- `git diff --check` 通过。
- `rg -n "alter-ego|doctor|tutor|potato|falcon|\\bman\\b" README.md` 无匹配。
- `rg -n "Moss|moss" README.md` 无匹配。
- `npm run check-readme` 未通过，报告 README 仍缺少多条既有命令、`.env.example` 变量和 CLI 命令索引；本次 README 空白启动说明没有扩大处理该历史覆盖率缺口。

## Commit Hash

- 待提交后回填。

## 构建与运行影响

- 仅 README 与计划文档改动，不影响运行时构建产物、Docker image、依赖或数据库迁移。
- 不需要重新构建或重启服务。
