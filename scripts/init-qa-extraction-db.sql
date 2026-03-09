-- Q&A 提取系统数据库表结构
-- 用于追踪消息处理、主题提取元数据、待审核 Q&A 和审核日志

-- 1. 消息处理追踪表
CREATE TABLE IF NOT EXISTS message_processing_log (
  message_id TEXT PRIMARY KEY,           -- 消息指纹 hash
  session TEXT NOT NULL,                 -- 群组名称
  message_time TEXT NOT NULL,            -- 消息时间
  sender TEXT NOT NULL,                  -- 发送人
  content_hash TEXT NOT NULL,            -- 内容 hash（检测变化）
  processed_topics TEXT,                 -- 已处理的主题列表（逗号分隔）
  first_processed_at TEXT,               -- 首次处理时间
  last_processed_at TEXT,                -- 最后处理时间
  extraction_count INTEGER DEFAULT 0     -- 被提取次数
);

CREATE INDEX IF NOT EXISTS idx_msg_session ON message_processing_log(session);
CREATE INDEX IF NOT EXISTS idx_msg_time ON message_processing_log(message_time);
CREATE INDEX IF NOT EXISTS idx_msg_topics ON message_processing_log(processed_topics);

-- 2. 主题提取元数据表
CREATE TABLE IF NOT EXISTS topic_extraction_metadata (
  topic_name TEXT PRIMARY KEY,           -- 主题名称
  keywords TEXT NOT NULL,                -- 关键词列表（JSON）
  last_extraction_time TEXT,             -- 最后提取时间
  total_messages_scanned INTEGER DEFAULT 0,  -- 扫描消息总数
  total_qa_extracted INTEGER DEFAULT 0,  -- 提取 QA 总数
  date_range_start TEXT,                 -- 已扫描时间范围起点
  date_range_end TEXT,                   -- 已扫描时间范围终点
  related_groups TEXT,                   -- 相关群组（JSON）
  extraction_version INTEGER DEFAULT 1,  -- 提取逻辑版本号
  status TEXT DEFAULT 'pending'          -- pending/in_progress/completed/needs_review
);

-- 3. 待审核 Q&A 表
CREATE TABLE IF NOT EXISTS knowledge_pending (
  id TEXT PRIMARY KEY,                   -- 唯一标识
  question TEXT NOT NULL,                -- 问题
  answer TEXT NOT NULL,                  -- 答案
  tags TEXT,                             -- 标签
  related_users TEXT,                    -- 回答者（最多2位，逗号分隔）
  source_session TEXT,                   -- 来源群组
  source_time TEXT,                      -- 来源时间
  source_message_ids TEXT,               -- 来源消息 ID 列表（JSON）
  topic_name TEXT,                       -- 所属主题
  extraction_version INTEGER DEFAULT 1,  -- 提取版本号
  extracted_at TEXT,                     -- 提取时间
  extracted_by TEXT DEFAULT 'auto-extractor',  -- 提取者

  -- 审核相关
  review_status TEXT DEFAULT 'pending',  -- pending/approved/rejected/edited/merged
  review_priority INTEGER DEFAULT 3,     -- 审核优先级 1-5
  auto_quality_score REAL,               -- LLM 自评分
  merged_into_id TEXT,                   -- 被合并到的目标 QA ID（合并时设置）

  UNIQUE(question, topic_name)           -- 同主题下问题不重复
);

CREATE INDEX IF NOT EXISTS idx_pending_status ON knowledge_pending(review_status);
CREATE INDEX IF NOT EXISTS idx_pending_topic ON knowledge_pending(topic_name);
CREATE INDEX IF NOT EXISTS idx_pending_priority ON knowledge_pending(review_priority DESC);
CREATE INDEX IF NOT EXISTS idx_pending_merged_into ON knowledge_pending(merged_into_id);

-- 4. 审核日志表
CREATE TABLE IF NOT EXISTS knowledge_review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_id TEXT NOT NULL,              -- 关联 pending 表
  reviewer TEXT NOT NULL,                -- 审核人
  action TEXT NOT NULL,                  -- approve/reject/edit/skip/merge/merge-primary
  comment TEXT,                          -- 审核备注
  reviewed_at TEXT NOT NULL,             -- 审核时间

  -- 如果是编辑，记录修改前后
  original_question TEXT,
  original_answer TEXT,
  edited_question TEXT,
  edited_answer TEXT,

  FOREIGN KEY (pending_id) REFERENCES knowledge_pending(id)
);

CREATE INDEX IF NOT EXISTS idx_review_pending ON knowledge_review_log(pending_id);
CREATE INDEX IF NOT EXISTS idx_review_time ON knowledge_review_log(reviewed_at);

-- 5. 审核统计视图
CREATE VIEW IF NOT EXISTS review_stats AS
SELECT
  topic_name,
  COUNT(*) as total,
  SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) as pending,
  SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) as approved,
  SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) as rejected,
  SUM(CASE WHEN review_status = 'edited' THEN 1 ELSE 0 END) as edited,
  SUM(CASE WHEN review_status = 'merged' THEN 1 ELSE 0 END) as merged
FROM knowledge_pending
GROUP BY topic_name;

-- 6. 扩展现有 knowledge 表（如果需要）
-- ALTER TABLE knowledge ADD COLUMN source_message_ids TEXT;
-- ALTER TABLE knowledge ADD COLUMN extraction_version INTEGER DEFAULT 1;
-- ALTER TABLE knowledge ADD COLUMN reviewed_by TEXT;
-- ALTER TABLE knowledge ADD COLUMN reviewed_at TEXT;
-- ALTER TABLE knowledge ADD COLUMN review_comment TEXT;
