# Tutor 错题集升级计划

## 目标

把 `tutor` 现在基于 `memory` 文本的错题记录，升级为真正可查询、可统计、可回顾、可保存原始附件题目的结构化错题集。

## 关键判断

- 错题正文、状态、次数、分析结果适合放数据库，便于筛选、汇总和回顾。
- 原始错题附件（图片、`word`、`pdf` 等）适合落盘保存，不适合直接塞进 SQLite。
- 因此首版采用“文件存储原始附件 + 数据库存索引”的混合方案，而不是“纯文件存储”。

项目里已有接近的先例：文档模块会把原始文件复制到 `data/documents/...`，同时在数据库里记录 `stored_path` 等元数据，后续再做检索和删除。

## 原始错题附件的保存方式

### 目录结构

建议新增目录：

```text
data/wrong-questions/<agentId>/<userId>/<wrongQuestionId8>/
```

目录内保存：

- `original-1.jpg` / `original-1.png`
- `original-2.jpg`（同一题多张照片时）
- `original.docx`
- `original.pdf`
- `ocr.md`（可选，后续如果做 OCR 文本沉淀）
- `meta.json`（可选，仅调试时需要；首版可不加）

### 数据库存什么

主表 `wrong_questions` 存：

- `id`
- `agent_id`
- `user_id`
- `subject`
- `question_summary`
- `wrong_answer`
- `error_type`
- `error_subtype`
- `analysis`
- `status`
- `mistake_count`
- `source_type` (`text` / `image` / `document`)
- `storage_dir`
- `created_at`
- `updated_at`
- `last_wrong_at`
- `mastered_at`

其中 `subject` 不使用自由文本，首版固定为以下四类：

- `math`（数学）
- `chinese`（语文）
- `english`（英语）
- `science`（科学）

这样做的目的：

- 便于报告按学科稳定汇总
- 避免同义词导致统计分裂
- 便于后续在 prompt、tool schema、CLI 命令里统一约束

如果只支持一个原始附件，`storage_dir` 就够了。

如果要支持多张图片、原始 `word/pdf`、老师批注图、裁剪图，建议再加子表 `wrong_question_assets`：

- `id`
- `wrong_question_id`
- `asset_role` (`original` / `annotated` / `cropped` / `ocr`)
- `file_name`
- `file_ext`
- `mime_type`
- `size_bytes`
- `stored_path`
- `sort_order`
- `created_at`

这样首版能先只写 `original`，以后扩展不会推翻结构。

## 为什么不建议纯文件存储

纯文件存储看起来简单，但一旦进入真实使用，会马上补出很多“隐形数据库”需求：

- 要按孩子、科目、错误类型筛选
- 要统计同类题错了几次
- 要标记“已掌握”
- 要生成家长报告
- 要做权限隔离
- 要做删除、去重、重命名、批量查看

如果只存文件，最后还是要靠文件名约定、目录层级、JSON sidecar 去补这些能力，复杂度会比“DB 管结构，文件管原图”更高。

所以更合适的取舍是：

- 文件系统负责保存大文件和原始附件
- SQLite 负责保存结构化字段、索引、状态和路径引用

## 方案调整

### 1. 表设计

在 `src/db/schema.ts` 新增：

- `wrong_questions`
- `wrong_question_assets`（推荐首版一起加上）

并补索引：

- `(agent_id, user_id, status)`
- `(agent_id, user_id, subject)`
- `(wrong_question_id, asset_role)`

其中 `wrong_questions.subject` 建议加 `CHECK` 约束，仅允许：

```sql
CHECK(subject IN ('math', 'chinese', 'english', 'science'))
```

### 1.5. Tutor 专属工具隔离

这次新增的错题 tools 必须是 `tutor` 专属，不能让其他 agent 查看或访问。

约束如下：

- 不把错题 tools 加入 `src/llm/agents/config.ts` 的 `COMMON_SET`
- 只通过 `src/db/schema.ts` 的 migration，把这些 tools 追加到 `tutor` 的 `tools_list`
- 依赖现有 `getAgentTools(...)` 过滤，保证只有 `tutor` 能在 agentic chat 中看到这些 tools
- 如后续发现某些 agent 已误配这些 tools，再补 migration 做清理，而不是放任其留在共享集合中

首版限定为 `tutor` 专属的 tools：

- `record_wrong_question`
- `list_wrong_questions`
- `mark_wrong_question_mastered`
- `wrong_question_report`

这样可以保证：

- `doctor`、`otcclaw`、`alter-ego` 等 agent 不会在 tool 列表中看到这些 tools
- 这些 agent 也无法通过自然语言路由或 agentic tool call 调用它们
- `tutor` 的 prompt 可以直接使用这些 tools，而不用担心跨 agent 泄露

### 2. 文件持久化

参考 `src/commands/document-import.ts` 的做法，在 `src/commands/` 新增错题文件持久化辅助函数：

- 创建错题目录
- 复制原始附件
- 返回相对路径，如 `data/wrong-questions/<agent>/<user>/<id8>/original-1.jpg`

路径应存相对路径，不存绝对路径，避免部署和工作目录变化带来的问题。

### 3. 领域命令

新增 `src/commands/wrong-question.ts`：

- `recordWrongQuestion(...)`
- `listWrongQuestions(...)`
- `markWrongQuestionMastered(...)`
- `summarizeWrongQuestions(...)`
- `attachWrongQuestionAsset(...)`

其中 `recordWrongQuestion(...)` 负责：

- 按 `agent_id + user_id + subject + question_summary` 去重
- 更新 `mistake_count`
- 在有附件时创建目录并保存原始文件
- 写入 `wrong_question_assets`

### 4. LLM tools

新增 `src/tools/wrong-question-tools.ts`：

- `record_wrong_question`
- `list_wrong_questions`
- `mark_wrong_question_mastered`
- `wrong_question_report`

其中 tool schema 里的 `subject` 也固定枚举为：

- `math`
- `chinese`
- `english`
- `science`

这些 tools 的接入方式必须是：

- 在全局 tool registry 中注册实现
- 但只给 `tutor` agent 分配可见性
- 不通过 `COMMON_SET` 暴露给全部 standard agent

如果后续需要让 agent 主动接收本地附件路径，也可以追加：

- `attach_wrong_question_asset`

### 5. Tutor prompt

更新 `config/agents/tutor.md`：

- 不再要求把错题实体写进 `memory`
- 文本题使用结构化错题工具入库
- 附件题除结构化字段外，还保存原始文件
- 记录错题时必须先判断学科，并严格落到“数学 / 语文 / 英语 / 科学”四类之一
- `memory` 只保留学习风格、长期偏好等轻量上下文

### 6. 家长查看入口

在 `src/commands/router.ts` 增加命令，例如：

- `/wrongq list`
- `/wrongq report`
- `/wrongq show <id>`
- `/wrongq mastered <id>`

其中 `/wrongq show <id>` 可显示结构化信息，并给出原始附件信息、存储位置或后续发送文件能力。

命令入口也要做 agent 隔离：

- 仅在当前 agent 为 `tutor` 时展示 `/wrongq ...`
- 即使用户手动输入命令，handler 也要再次校验当前 agent 是否为 `tutor`
- 避免出现“命令不可见但仍可跨 agent 调用”的绕过情况

报告默认按以下维度汇总：

- 学科
- 错误类型
- 未掌握 / 已掌握
- 最近错误时间

## 推荐落地顺序

1. 先落 `wrong_questions` + `wrong_question_assets` 表。
2. 复用文档模块的文件落盘思路，打通图片和 `word/pdf` 附件保存。
3. 只把错题 tools 分配给 `tutor`，并做好非 `tutor` agent 的隔离验证。
4. 再补 tools 和 CLI 查询。
5. 最后改 `tutor.md`，切走旧 `memory` 错题协议。

## 结论

带附件上传的错题，最稳妥的保存方式是：

- 原始附件保存到 `data/wrong-questions/...`
- 结构化字段和文件路径保存到数据库

这比“只用文件存储”更适合你现在这个项目，也更容易把错题集真正做成可用功能，而不是一堆难维护的附件文件夹。

学科维度首版固定为：

- 数学
- 语文
- 英语
- 科学

另外，错题 tools 与 `/wrongq` 命令首版只属于 `tutor`，其他 agent 不应查看、访问或调用。
