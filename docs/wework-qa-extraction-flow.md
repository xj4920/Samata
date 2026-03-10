# 企微 Q&A 提取流程

## 整体架构

系统有两条提取路径，共享底层的消息聚合和 LLM 提取能力：

```
                           ┌─────────────────────────────────────────────────┐
                           │             /qa 管线（完整流程）                  │
┌─────────────┐            │                                                 │
│  主题配置    │ ─────────▶│  extract → merge → review → 入库 knowledge      │
│ (topics)    │            │  (增量提取)  (合并去重) (人工审核)                 │
└─────────────┘            │                                                 │
      │                    │  辅助命令: clean / validate / score              │
      │                    └─────────────────────────────────────────────────┘
      │
      │                    ┌─────────────────────────────────────────────────┐
      │                    │         /wework-qa（轻量查询）                    │
      └──────────────────▶│  关键词搜索 → 过滤 → LLM 提取 → 直接输出          │
                           │  (无持久化，无审核流程)                            │
                           └─────────────────────────────────────────────────┘
```

---

## 路径一：/wework-qa 轻量提取

`src/commands/wework-qa.ts` 提供即时提取能力，不写入数据库，适合临时查询。

### 流程

```
关键词搜索（每个关键词 fetchWeworkMessages, limit=500）
       │
       ▼
消息指纹去重（time-sender-content）
       │
       ▼
时间/人员过滤（可选）
       │
       ▼
LLM 提取（generateTopicPrompt → 单次调用）
       │
       ▼
直接输出 QAPair[]
```

### 入口

**CLI** — `/wework-qa topics=FIX,fix协议 [people=张三] [start=2024-01-01] [end=2024-12-31] [session=群名] [limit=10]`

**Agent Tool** — `extract_wework_qa`（`src/llm/agent.ts` 中注册，薄包装调用 `extractWeworkQA()`）

---

## 路径二：/qa 完整管线

通过 `src/commands/qa.ts` 统一入口，调用 `scripts/` 下的独立脚本。数据持久化到 SQLite（`data/yanyu.db`）。

```
/qa extract [topic] [limit]     增量提取
/qa merge [topic]               合并相似 QA（交互式）
/qa review [topic]              人工审核（交互式）
/qa validate [topic]            完整性验证
/qa score <topic>               质量评分
/qa clean <topic>               清理主题数据（重新提取）
```

### 阶段一：主题定义

`scripts/topics-config.ts` 维护主题清单，每个主题包含：
- **名称**（如 `FIX协议对接`）
- **关键词组**（如 `['FIX', 'fix协议', 'fix认证']`）
- **优先级** 1-5（5 最高）
- **相关群组**（可选，缩小搜索范围）
- **时间范围**（可选）

当前主题分级：

| 优先级 | 主题 |
|--------|------|
| 5 | FIX协议对接、API认证问题、交易拒单处理 |
| 4 | 专线接入、北上资金数据、估值计算、风控配置、断线重连机制 |
| 3 | 交易数据加工、开户流程、查询功能、算法单 |
| 2 | 系统部署、时延优化、日志排查 |

同时维护标准 QA 标签列表 `QA_TAGS`，供 LLM 提取时分类。

### 阶段二：增量提取（/qa extract）

`scripts/incremental-extract.ts`，核心流程：

```
1. 跨群消息聚合
       │  每个关键词 fetchWeworkMessages(limit=1000)
       │  相关群组过滤（relatedGroups）
       │  消息指纹去重 + 按时间排序
       ▼
2. 增量过滤
       │  查询 message_processing_log 表
       │  分类：新消息 / 已处理(跳过) / 内容变化(重新处理)
       │  版本升级时强制重新提取
       ▼
3. 分窗口 LLM 提取
       │  固定窗口 100 条，时间跨度 >7 天强制切分
       │  每个窗口独立调用 LLM（带重试，指数退避）
       │  JSON 格式校验 + 修复
       ▼
4. 跨窗口去重
       │  问题前 50 字符相同视为重复
       ▼
5. 质量评分（≤20 条时自动评分）
       │  调用 qa-quality-scorer（1-5 分）
       ▼
6. 写入 knowledge_pending 表（review_status = 'pending'）
7. 标记 message_processing_log（消息已被该主题处理）
8. 更新 topic_extraction_metadata（扫描范围、QA 数等元数据）
```

#### 增量过滤机制

每条消息有两个标识：
- **消息指纹**（`generateMessageFingerprint(time, sender, content, session)`）→ 判断是否见过
- **内容 hash**（`contentHash`）→ 判断内容是否变化

每条消息记录了"已被哪些主题处理过"（`processed_topics` 逗号分隔），同一条消息可被不同主题各处理一次，但同一主题不会重复处理。

#### 提取版本控制

```
EXTRACTION_VERSION: 1 → 2

已用 v1 提取的消息会被重新处理（forceReExtract）
新提取的 QA 作为新记录写入 pending（INSERT OR IGNORE）
```

### 阶段三：相似合并（/qa merge）

`scripts/merge-qa.ts`，在提取和审核之间运行，减少审核工作量：

```
1. 获取 pending QA（至少 3 条才触发）
       │
       ▼
2. LLM 相似性检测
       │  字符 bigram Jaccard 排序（相似问题聚在一起，无 LLM 开销）
       │  排序后分批 30 条，发送问题列表给 LLM
       │  Union-Find 合并传递性相似组（[0,1] + [1,2] → [0,1,2]）
       ▼
3. 交互式合并
       │  展示每组相似问题
       │  操作选项:
       │    a = 自动合并（LLM 精炼问题，保留最佳答案）
       │    p = 手动选主答案
       │    c = 合并问题+答案（LLM 同时合并 Q 和 A）
       │    s = 跳过
       │    q = 退出
       ▼
4. 执行合并
       │  主项：更新 question/answer、合并 tags/related_users/source_message_ids
       │  被合并项：review_status → 'merged'，记录 merged_into_id
       │  记录审核日志（merge / merge-primary）
```

### 阶段四：人工审核（/qa review）

`scripts/review-qa.ts`，交互式逐条审核：

```
            待审核队列
            （按 review_priority DESC, auto_quality_score DESC 排序）
                │
                ▼
        ┌───────────────────┐
        │  展示单条 QA       │
        │  主题/标签/来源/时间│
        │  质量评分          │
        │  问题/答案         │
        └────────┬──────────┘
                 │
     ┌───────┬───┴───┬───────┐
     ▼       ▼       ▼       ▼
  批准(a)  编辑(e)  拒绝(r)  跳过(s) / 退出(q)
     │       │       │
     ▼       │       ▼
  语义去重   │    标记 rejected
  检查      │    记录审核日志
  (qa-dedup)│
     │       │
  ┌──┴──┐    │
  │重复？│    │
  └──┬──┘    │
  ┌──┴──┐    ▼
  │s/r/a│  修改 Q&A
  └──┬──┘  review_status → 'edited'
     ▼     记录审核日志
  写入 knowledge 正式库
  review_status → 'approved'
  记录审核日志
```

审核批准时的语义去重（`src/utils/qa-dedup.ts`）：
- Layer 1：字符 bigram Jaccard 相似度筛选
- Layer 2：LLM 语义判定（仅对 top-N 候选）
- 发现重复时可选：跳过(不入库) / 替换已有 / 仍然添加

### 阶段五：辅助工具

**质量评分** — `/qa score <topic>`（`scripts/score-topic.ts`）
- 对未评分的 pending QA 调用 LLM 评估（1-5 分）

**完整性验证** — `/qa validate [topic]`（`scripts/validate-extraction-coverage.ts`）
- 检查主题提取元数据、提取率、待审核/已批准数量
- 检测时间覆盖缺口（>30 天间隔）

**清理重置** — `/qa clean <topic>`（`scripts/clean-topic.ts`）
- 删除审核日志、pending QA、消息处理标记、主题元数据
- 用于从头重新提取

---

## 主题专属 Prompt

`src/utils/topic-prompts.ts` 为不同主题定制提取策略。

### 匹配逻辑（`getTopicPromptConfig()`）

1. 精确匹配主题名称
2. 关键词包含匹配
3. 兜底返回"通用"配置

### Prompt 配置（`TopicPromptConfig`）

| 字段 | 说明 |
|------|------|
| `extractionStrategy` | 专属提取策略（如 FIX 主题强调字段编号、错误代码、泛化要求） |
| `mustExtractTypes` | 必须提取的内容类型列表 |
| `extractionFocus` | 提取重点和质量要求 |
| `examples` | 提取示例（few-shot） |

已配置专属 prompt 的主题：
- **FIX协议对接** — tag 字段、错误代码、消息类型，严格泛化客户信息
- **费率与限额** — 数值、计算公式、分层信息
- **交易标的范围** — 标的清单、准入条件、限制说明
- **异常交易认定** — 判定标准、阈值、监控规则
- **专线接入** — 接入方式、申请流程、故障排查，严格泛化客户信息
- **通用** — 兜底配置

### 生成的 Prompt 结构

```
1. 角色定义 + 主题名称
2. 主题专属提取策略
3. 必须提取的内容类型
4. 可用标签列表（QA_TAGS）
5. 严格排除的内容（临时安排、个性化需求、简单确认等）
6. 提取标准 + 数量限制
7. 提取示例（few-shot）
8. 聊天记录格式说明 + 实际聊天记录
9. 输出格式要求（JSON 数组）
```

---

## 数据库表结构

SQLite 数据库 `data/yanyu.db`，建表脚本 `scripts/init-qa-extraction-db.sql`。

### message_processing_log（消息处理追踪）

| 字段 | 类型 | 说明 |
|------|------|------|
| message_id | TEXT PK | 消息指纹 hash |
| session | TEXT | 群组名称 |
| message_time | TEXT | 消息时间 |
| sender | TEXT | 发送人 |
| content_hash | TEXT | 内容 hash（检测变化） |
| processed_topics | TEXT | 已处理的主题列表（逗号分隔） |
| first_processed_at | TEXT | 首次处理时间 |
| last_processed_at | TEXT | 最后处理时间 |
| extraction_count | INTEGER | 被提取次数 |

### topic_extraction_metadata（主题提取元数据）

| 字段 | 类型 | 说明 |
|------|------|------|
| topic_name | TEXT PK | 主题名称 |
| keywords | TEXT | 关键词列表（JSON） |
| last_extraction_time | TEXT | 最后提取时间 |
| total_messages_scanned | INTEGER | 扫描消息总数 |
| total_qa_extracted | INTEGER | 提取 QA 总数 |
| date_range_start | TEXT | 已扫描时间范围起点 |
| date_range_end | TEXT | 已扫描时间范围终点 |
| related_groups | TEXT | 相关群组（JSON） |
| extraction_version | INTEGER | 提取逻辑版本号 |
| status | TEXT | pending / in_progress / completed / needs_review |

### knowledge_pending（待审核 QA）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 唯一标识 |
| question | TEXT | 问题 |
| answer | TEXT | 答案 |
| tags | TEXT | 标签（逗号分隔） |
| related_users | TEXT | 回答者（最多 2 位，逗号分隔） |
| source_session | TEXT | 来源群组 |
| source_time | TEXT | 来源时间 |
| source_message_ids | TEXT | 来源消息 ID 列表（JSON） |
| topic_name | TEXT | 所属主题 |
| extraction_version | INTEGER | 提取版本号 |
| extracted_at | TEXT | 提取时间 |
| extracted_by | TEXT | 提取者（默认 auto-extractor） |
| review_status | TEXT | pending / approved / rejected / edited / merged |
| review_priority | INTEGER | 审核优先级 1-5 |
| auto_quality_score | REAL | LLM 自评分 |
| merged_into_id | TEXT | 被合并到的目标 QA ID |

UNIQUE 约束：`(question, topic_name)`

### knowledge_review_log（审核日志）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 ID |
| pending_id | TEXT FK | 关联 pending 表 |
| reviewer | TEXT | 审核人 |
| action | TEXT | approve / reject / edit / skip / merge / merge-primary |
| comment | TEXT | 审核备注 |
| original_question | TEXT | 编辑前问题 |
| original_answer | TEXT | 编辑前答案 |
| edited_question | TEXT | 编辑后问题 |
| edited_answer | TEXT | 编辑后答案 |
| reviewed_at | TEXT | 审核时间 |

### review_stats（审核统计视图）

按 `topic_name` 汇总 total / pending / approved / rejected / edited / merged。

---

## 核心文件

| 文件 | 职责 |
|------|------|
| `scripts/topics-config.ts` | 主题清单（名称、关键词、优先级）+ QA 标签列表 |
| `src/utils/topic-prompts.ts` | 主题专属 prompt 配置 + prompt 生成 |
| `src/commands/wework-qa.ts` | 轻量提取（消息聚合 + 过滤 + LLM 调用 + CLI 入口） |
| `src/commands/qa.ts` | /qa 管线入口（dispatch 到 scripts/） |
| `scripts/incremental-extract.ts` | 增量提取（分窗口 + 持久化 + 版本控制） |
| `scripts/merge-qa.ts` | 相似 QA 合并（LLM 检测 + 交互式合并） |
| `scripts/review-qa.ts` | 人工审核（批准/编辑/拒绝 + 语义去重检查） |
| `scripts/score-topic.ts` | QA 质量评分 |
| `scripts/validate-extraction-coverage.ts` | 提取完整性验证 |
| `scripts/clean-topic.ts` | 清理主题数据 |
| `scripts/init-qa-extraction-db.sql` | 数据库建表脚本 |
| `src/utils/qa-quality-scorer.ts` | LLM 质量评分（1-5 分） |
| `src/utils/qa-dedup.ts` | 语义去重（bigram Jaccard + LLM 两层过滤） |
| `src/utils/message-fingerprint.ts` | 消息指纹生成 |
| `src/llm/agent.ts` | Agent tool 注册（extract_wework_qa） |
