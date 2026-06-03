# Wiki 同步子项目

## Context

从内部 Wiki（Confluence）拉取页面内容，转为 markdown 后存档，再通过 Samata 的 `import_document` 导入并绑定到 ticlaw agent（name: `ticlaw`，id: `agent-ticlaw`），实现 wiki 资料的可检索、可管理。

同步策略：**首次全量导入 + 每日增量检查更新**。

核心依赖 `confluence-markdown-exporter`（`cf-export`）承担所有 Confluence→MD 的繁重工作，wiki-sync 只做薄层编排。

## 架构

```
confluence-markdown-exporter (Python, pip install)
    │
    │  直连 Confluence REST API (atlassian-python-api SDK)
    │  ├── 页面导出 (HTML→MD, ~1300行自定义 MarkdownConverter)
    │  ├── 附件下载 (图片/Gliffy/Draw.io/PlantUML/Jira/全部宏)
    │  ├── 增量检测 (LockfileManager: 对比 version.number, 跳过未变更页)
    │  ├── 并发导出 (ThreadPoolExecutor, 可配 worker 数)
    │  └── 过期清理 (--cleanup-stale, 检测 Confluence 已删除页)
    │
    ▼
输出目录: wiki-sync/data/archive/<space_name>/
    │  (由 cf-export page_path 模板控制)
    │
    ▼
wiki-sync/src/ (TypeScript 薄层, ~300行)
    ├── cron.ts           # 每日调度 cf-export + 检测 lockfile 变更
    └── import-bridge.ts  # 通过 Samata CLI HTTP API 调用 /doc-import
```

## 子项目结构

```
wiki-sync/
├── package.json
├── tsconfig.json
├── config.yaml              # Confluence 连接 + Samata 连接 + 空间列表 + cron
├── src/
│   ├── index.ts             # CLI 入口: sync/import/status
│   ├── cron.ts              # 每日定时: 执行 cf-export → 对比 lockfile → 触发 import
│   └── import-bridge.ts     # 通过 Samata CLI HTTP API 桥接导入
├── data/
│   ├── archive/             # cf-export 输出目录 (gitignore)
│   └── snapshot.json        # 上次运行时的 lockfile 副本 + page_id→document_id 映射
└── logs/
```

## 技术方案

### 1. confluence-markdown-exporter 承担的部分

安装：`pip install "git+https://github.com/JaysonAlbert/confluence-markdown-exporter.git"`

**核心能力**（无需自研）：

| 能力 | 实现 |
|---|---|
| 单页/子页/Space/全Space 导出 | `cf-export pages` / `pages-with-descendants` / `spaces` / `all-spaces` |
| HTML→Markdown | 自定义 `MarkdownConverter(TableConverter)`，处理全部 Confluence 宏 |
| 图片 | 自动匹配 attachment ID，下载到本地，markdown 引用本地路径 |
| Gliffy 图 | PNG 预览 + 源文件链接 |
| Draw.io 图 | PNG 预览 + 源文件链接 + Mermaid 图提取 |
| PlantUML | 提取为 markdown code block |
| Confluence 宏 | alert/panel/toc/jira/expand/details/task-list 全部支持 |
| YAML frontmatter | 可选，含 page_id/space_key/title/url |
| 增量导出 | LockfileManager 对比 version.number，版本未变则跳过 |
| 并发导出 | ThreadPoolExecutor，默认 5 workers |
| 过期清理 | `--cleanup-stale` 检测 Confluence 中已删除的页面并清理本地 |
| 附件路径模板 | 可配置与 page.md 同目录（`{page_parent_path}/{attachment_file_id}{attachment_extension}`） |

**配置示例**（`cf-export config` 交互式设置或直接写 JSON）：
```json
{
  "auth": {
    "confluence": {
      "url": "https://confluence.internal.example.com",
      "username": "...",
      "api_token": "..."
    }
  },
  "export": {
    "output_path": "./data/archive",
    "page_path": "{space_name}/{ancestor_titles}/{page_title}.md",
    "attachment_path": "{page_parent_path}/images/{attachment_file_id}{attachment_extension}",
    "attachment_export_all": false,
    "page_breadcrumbs": true,
    "include_yaml_frontmatter": true,
    "parallel_downloads": 5
  }
}
```

**关键配置说明**：
- `attachment_path` 设为 `{page_parent_path}/images/...` 将附件（图片）放入 page.md 同目录的 `images/` 子目录，这样 markdown 中的 `![](images/xxx.png)` 引用与 `importDocument` 处理 docx/pdf 提取图片的 `images/` 目录约定一致
- `include_yaml_frontmatter: true` 使导出的 markdown 包含 page metadata，import-bridge 可从中提取 `page_id`、`version`、`url` 等信息

**导出后本地目录结构**：
```
data/archive/<space_name>/
├── <page_title>.md
├── <子目录>/
│   ├── <子页面>.md
│   └── images/
│       ├── <file_id>.png
│       └── <file_id>.xlsx
└── images/
    └── <file_id>.png
```

**lockfile 格式**（由 cf-export LockfileManager 维护）：
```json
{
  "<page_id>": {
    "version": 42,
    "last_exported_at": "2026-04-27T10:30:00Z",
    "title": "某页面标题",
    "space_key": "OPS"
  }
}
```

### 2. wiki-sync 自研的薄层

#### import-bridge.ts — Samata 导入桥接

**通信方式**：wiki-sync 作为独立进程，通过 Samata 的 CLI HTTP API（`http://127.0.0.1:3457`）与 Samata 通信。

**API 端点**（来源：`src/server/cli-api.ts`）：
- `POST /api/cli/session` — 创建会话，body: `{ username, agentName }`
- `POST /api/cli/execute` — 执行命令，body: `{ sessionId, input }`，返回 `{ ok, output[], error? }`
- `DELETE /api/cli/session` — 销毁会话

**权限要求**：`/doc-import` 命令标记了 `requiredRole: 'agent_admin'`，因此 session 的 username 必须对 ticlaw agent 有 admin 权限。wiki-sync 需在 config.yaml 中配置一个 admin 用户名（如 `admin-001`，已在 seed 中设为 ticlaw 的 admin）。

**导入流程**：

```
对每个待导入/更新的页面:
    │
    ├── 1. 检测 page.md 的 YAML frontmatter，提取 page_id, version, title
    │
    ├── 2. 判断操作类型:
    │   ├── 新增 (page_id 不在 snapshot 中)
    │   │   └── POST /api/cli/execute { input: "/doc-import <page.md路径>" }
    │   │
    │   └── 更新 (page_id 在 snapshot 中, version 已变)
    │       ├── 先删除旧文档:
    │       │   └── POST /api/cli/execute { input: "/doc-del <document_id>" }
    │       └── 再导入新版:
    │           └── POST /api/cli/execute { input: "/doc-import <page.md路径>" }
    │
    ├── 3. 解析返回的 output，提取 document ID（格式: [8位ID] 标题）
    │
    ├── 4. 遍历 page.md 同级 images/ 目录下的非图片附件 (.xlsx/.pdf/.docx):
    │   └── POST /api/cli/execute { input: "/doc-import <附件路径>" }
    │
    └── 5. 记录 page_id → { document_id, version } 到 snapshot
```

**doc_date 传递**：从 Confluence 页面 metadata（YAML frontmatter 中的 `updated` 或 `created` 字段）提取日期，通过 `/doc-import` 的扩展参数传递。当前 `/doc-import` 命令不支持 `--doc-date` 参数，需要先在 `src/commands/document-import.ts` 的 `cliImport` 中添加对该参数的支持，或者 import-bridge 直接调用 `importDocument()` 函数（需要 wiki-sync 与 Samata 运行在同一 Node 进程内——不符合独立子项目定位）。

短期方案：import-bridge 调用 `/doc-import` 时不传 doc_date（由 LLM 在后续检索时从 frontmatter 推断）。长期方案：扩展 `/doc-import` 命令支持 `--doc-date YYYY-MM-DD` 参数。

**附件处理**：
- **图片**（.png/.jpg/.gif/.webp/.svg）：cf-export 下载到 `images/` 子目录，markdown 中以 `![](images/<id>.png)` 引用。`importDocument` 处理 `.md` 文件时直接 `fs.readFileSync` 读取原文（`document-import.ts:650`），需要确认图片相对路径在导入后能否正确解析。
- **非图片附件**（.xlsx/.pdf/.docx）：单独调用 `/doc-import` 导入每个附件，利用 Samata 对各格式的专门处理

#### cron.ts — 每日调度

```
每日 2:00 触发
    │
    ├── 1. 执行 cf-export spaces <KEY> --output-path ./data/archive
    │   (LockfileManager 自动跳过未变更页)
    │   ├── 成功 → 继续
    │   └── 失败 → 记录日志，指数退避重试 (最多 3 次, 间隔 5min/10min/20min)
    │
    ├── 2. 读取本次 lockfile + 上次 snapshot
    │
    ├── 3. 逐页对比:
    │   ├── lockfile 有, snapshot 无 → 新增页面 → import-bridge.importPage()
    │   ├── lockfile 有, snapshot 有, version 不同 → 变更页面 → import-bridge.reimportPage()
    │   ├── lockfile 有, snapshot 有, version 相同 → 跳过
    │   └── lockfile 无, snapshot 有 → 页面已在 Confluence 删除 → 记录待清理
    │
    ├── 4. 对每个导入操作:
    │   ├── 先 GET /health 确认 Samata API 在线
    │   ├── 逐页导入 (顺序执行，避免并发写同一 agent 的文档表)
    │   └── 记录成功/失败，失败页不阻塞后续页
    │
    └── 5. 保存本次 snapshot = lockfile + 新 document_id 映射
```

#### 错误处理与重试策略

| 场景 | 策略 |
|---|---|
| cf-export 执行失败 | 指数退避重试 3 次（5min/10min/20min），全部失败则告警并退出本轮 |
| Samata API 不在线 | 等待 1min 后重试，最多 3 次 |
| 单页导入失败 | 记录日志，继续导入下一页；本轮结束后汇总失败列表 |
| content_hash 去重拦截 | 视为正常（内容未变），更新 snapshot 中的 version 但保留原 document_id |
| API 返回非 ok | 记录 error 字段，跳过该页 |

### 3. 状态追踪

```
cf-export 的 lockfile.json 已记录:
  - page_id → version.number + last_exported_at

wiki-sync 的快照文件 (wiki-sync/data/snapshot.json):
  {
    "last_run": "2026-04-27T02:05:00Z",
    "pages": {
      "<page_id>": {
        "version": 42,
        "document_id": "a1b2c3d4",   // Samata document ID (8位前缀)
        "title": "某页面标题",
        "imported_at": "2026-04-27T02:06:00Z"
      }
    },
    "attachments": {
      "<page_id>/<attachment_file_id>": {
        "document_id": "e5f6g7h8",
        "filename": "report.xlsx"
      }
    }
  }
```

每次 cron 运行后对比 lockfile（当前） vs snapshot.pages（上次），差异即为待导入/重导入项。

### 4. CLI 命令

```bash
# 全量同步（首次运行：cf-export + import）
npm start -- sync --full

# 增量同步（仅 cf-export 变更页 + import）
npm start -- sync

# 仅执行 cf-export（不触发 Samata import）
npm start -- export

# 仅导入（从已有 archive 目录导入到 Samata）
npm start -- import

# 查看同步状态
npm start -- status

# 启动每日定时任务
npm start -- cron
```

### 5. 待确认

1. Confluence 的 base URL 是什么？（`http://10.55.67.50:8081` 后端的 wiki 是否是 Confluence？）
2. 认证方式：PAT 还是 username + API token？
3. 需要同步哪些 Space？Space key 是什么？
4. wiki-sync 的 admin 用户：`admin-001`（seed 中已设为 ticlaw 的 agent admin）

## 验证方式

1. 安装 `cf-export`，配置 Confluence 连接，执行 `cf-export spaces <KEY> --output-path ./data/archive` 验证导出
2. 检查输出目录结构、markdown 质量、附件完整性
3. 确认 markdown 中图片引用路径与 `images/` 目录一致，`importDocument` 能正确处理
4. `npm start -- import` 验证 Samata 导入桥接
5. 在 Samata 中用 `/doc-list` + `search_knowledge` 确认可检索
6. `npm start -- cron` 启动定时任务，等待次日验证增量更新
7. 模拟更新一个 Confluence 页面，验证增量检测和 reimport 流程
