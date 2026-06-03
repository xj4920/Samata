---
docModules:
  - platform
docTopics:
  platform: 文档与知识
canonicalDocs:
  - /platform/agent-capability-model
status: implemented
---

# 文档文件持久化存储

## 概述

为文档导入流程增加持久化存储：将用户上传的原始文件和解析后的 md/json 文件保存到 `data/documents/` 目录，并在 DB 中记录路径，使 reimport 和回溯不再依赖原始路径。

## 现状问题

当前 `importDocument` 只记录 `source_path`（用户提供的原始路径），不做文件拷贝。这意味着：
- 如果原始文件被移动/删除，`reimportDocument` 会失败
- bot channel 上传的文件存在 `os.tmpdir()/samata/uploads/`，重启后可能丢失
- 解析后的 markdown/JSON 中间产物完全没有保留，无法回溯查看

## 设计方案

在 gitignored 的 `data/` 目录下新建 `data/documents/` 存储区，每个导入的文档创建一个子目录：

```
data/documents/
  <doc-id-short>/
    original.pdf          # 原始文件副本
    parsed.md             # 解析后的完整 markdown（md/docx/pdf）
    parsed.json           # 解析后的完整 JSON（xlsx/csv）
```

### 存储规则
- **原始文件**：在 import 时拷贝一份到 `data/documents/<id>/`，保留原始扩展名
- **解析产物**：markdown 类 -> `parsed.md`；excel/csv 类 -> `parsed.json`（所有 sheet 数据）
- **reimport 时**：优先从 `stored_path`（data/ 下的副本）读取，而非 `source_path`

## 修改的文件

### 1. DB 变更：`src/db/schema.ts`

`documents` 表新增 `stored_path` 列（存储副本的目录路径）：

```sql
ALTER TABLE documents ADD COLUMN stored_path TEXT;
```

新增一条 migration `add-documents-stored-path`。

### 2. 核心逻辑：`src/commands/document-import.ts`

主要改动：

- 新增 `getDocStorageDir(docId)` 辅助函数，返回 `data/documents/<docId前8位>/`
- `importDocument` 流程调整：
  1. 生成 docId 后立即创建存储目录
  2. **拷贝原始文件** -> `<dir>/original.<ext>`
  3. 调用 `loadAndChunk` 获得 chunks（逻辑不变）
  4. **保存解析产物** -> `<dir>/parsed.md` 或 `<dir>/parsed.json`
  5. 插入 DB 时写入 `stored_path`
- `reimportDocument` 调整：优先使用 `doc.stored_path` 下的原始文件，而非 `doc.source_path`
- 新增 `getDocumentContent(docIdPrefix)` 导出函数：读取并返回 `parsed.md` / `parsed.json` 内容，供后续可能的 tool 使用
- `deleteDocument` 调整：删除 DB 记录后，同时 `rmSync` 对应的存储目录

### 3. .gitignore 确认

`data/` 已在 `.gitignore` 中，`data/documents/` 自动被忽略，无需额外操作。

## 关键实现细节

- 存储路径使用**项目根目录的相对路径**（通过 `import.meta.url` 推导），不 hardcode 绝对路径
- 对于 bot 上传的临时文件（`/tmp/samata/uploads/`），import 后文件被拷贝到 `data/documents/`，原始临时文件可安全清理
- `parsed.md` 保存的是解析后的完整 markdown 内容（在 chunk 拆分之前），方便后续重新拆分或调整 chunk 策略
- Excel 的 `parsed.json` 保存每个 sheet 的 markdown table 文本（与当前 chunk 内容一致）

## 状态

已完成实现（2026-04-14）。
