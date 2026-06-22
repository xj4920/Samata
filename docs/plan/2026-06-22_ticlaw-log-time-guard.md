---
docModules:
  - platform
docTopics:
  platform: TIClaw LogYi 时间范围护栏
canonicalDocs:
  - /platform/common-tools
status: implemented
---

# TIClaw 日志与知识检索时间范围收敛

## 背景

ticlaw 排查当天拒单问题时曾命中 2025 年 IF2506 合约正常到期清理日志，旧日志被误带入当前问题分析。该问题的风险不只是一次误判：一旦生产日志或知识检索默认扩大时间范围，历史材料会引入大量噪音，削弱当前故障定位的证据链。

## 决策

- 用户未明确时间范围时，LogYi 查询默认只查 Asia/Shanghai 当前自然日。
- 未明确时间范围时只查当日 00:00:00 ~ 当前时间，不设置额外相对时间窗口。
- 跨日、跨年、超过 7 天或历史回溯必须由用户明确给出绝对日期范围。
- 知识库导入文档复用已有 `doc_date`，不新增数据库字段；设置日期过滤时默认排除无 `doc_date` 文档。
- 长期规则写入 `config/agents/ticlaw.md`、工具描述和 MCP 调用护栏，不写入运行时 memory 表。

## 改动清单

- `config/agents/ticlaw.md`
  - 增加 LogYi 绝对时间范围、默认当日、禁止自行跨日/跨年和历史日志证据归类规则。
- `src/services/mcp-manager.ts`
  - 对 LogYi 搜索类 MCP 工具追加时间范围描述。
  - 调用前拒绝缺少时间范围、时间范围不完整、start 晚于 end、未经确认跨年、未经确认超过 7 天的查询。
  - 支持内部确认字段，调用外部 MCP 前会剥离确认字段。
- `src/llm/tool-types.ts`、`src/tools/knowledge-tools.ts`、`src/commands/knowledge.ts`、`src/utils/grep-search.ts`
  - `search_knowledge` 增加 `date_from`、`date_to`、`include_undated`。
  - 文档搜索解析并返回 `doc_date`，支持按材料日期过滤。
- `tests/unit/tools/knowledge.test.ts`、`tests/unit/services/mcp-manager-logyi-guard.test.ts`、`tests/unit/config/prompt-identity.test.ts`
  - 覆盖文档日期过滤、LogYi 时间范围护栏和 ticlaw prompt 规则。

## 验证命令

已执行：

```bash
git pull --ff-only
npm run test:unit -- tests/unit/tools/knowledge.test.ts
npm run test:unit -- tests/unit/services/mcp-manager-logyi-guard.test.ts tests/unit/config/prompt-identity.test.ts
npm run docs:plan-sync -- --check
npm run docs:plan-sync
git diff --check
```

结果：

- `git pull --ff-only`：已经是最新的。
- `tests/unit/tools/knowledge.test.ts`：1 个测试文件通过，8 个用例通过。
- `tests/unit/services/mcp-manager-logyi-guard.test.ts tests/unit/config/prompt-identity.test.ts`：2 个测试文件通过，9 个用例通过。
- `npm run docs:plan-sync -- --check`：生成索引已更新，但因既有历史 plan 缺少 `docModules` frontmatter 返回失败；本次新增文档未出现在错误列表。
- `npm run docs:plan-sync`：退出码 0，确认 `docs/.vitepress/plan-index.generated.ts` 已同步；仍打印同一批历史 frontmatter warning/error。
- `git diff --check`：通过，无空白错误。

补充探测：

```bash
npm view @gf/logyi-mcp@latest version dist.tarball --registry http://npm.gf.com.cn
```

结果：公司 npm registry 返回 `502 Bad Gateway`。本次实现位于 Samata MCP manager 层，不依赖读取外部 LogYi MCP 包源码。

## 构建与重启判断

本次改动影响运行时代码、工具 schema、agent prompt 和单测，不涉及数据库迁移、依赖或插件构建产物。若部署到当前 Docker 生产容器，需要重新构建并重启 Samata image/container，再确认 `MCP [logyi]` 连接日志。

## Commit Hash

- implementation commit hash: `00dbe8e00d218072ce0ace55279a22911ef7b18e`
- 当前基线 commit: `ac26fd2`
