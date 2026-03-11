# 企微 Q&A 提取系统使用指南

## 系统概述

完整的 Q&A 提取系统，实现了从企微聊天记录中自动提取、人工审核到知识库入库的全流程。

## 核心功能

1. **主题驱动提取** - 按业务主题跨群聚合消息
2. **增量处理** - 避免重复提取，支持断点续传
3. **分窗口提取** - 智能分割对话，提高提取质量
4. **人工审核** - 交互式 CLI 审核工具
5. **完整性验证** - 检查提取覆盖率和质量

## 快速开始

### 1. 初始化数据库

```bash
# 创建必要的数据库表
sqlite3 data/yanyu.db < sql/init-qa-extraction-db.sql
```

### 2. 配置主题

编辑 `scripts/topics-config.ts`，定义你的业务主题：

```typescript
{
  name: 'FIX协议对接',
  keywords: ['FIX', 'fix协议', 'fix接入'],
  priority: 5,
  relatedGroups: ['LinkRiver', 'Jump'],
}
```

### 3. 运行提取

```bash
# 提取所有主题（按优先级）
npx tsx scripts/incremental-extract.ts

# 提取指定主题
npx tsx scripts/incremental-extract.ts "FIX协议对接"
```

### 4. 人工审核

```bash
# 审核所有待审核 Q&A
npx tsx scripts/review-qa.ts

# 审核指定主题
npx tsx scripts/review-qa.ts "FIX协议对接"
```

审核操作：
- `a` - 批准（写入正式知识库）
- `r` - 拒绝（标记为拒绝）
- `s` - 跳过（稍后处理）
- `q` - 退出

### 5. 验证完整性

```bash
# 检查所有主题的提取完整性
npx tsx scripts/validate-extraction-coverage.ts
```

## 工作流程

```
1. 定义主题 (topics-config.ts)
   ↓
2. 运行增量提取 (incremental-extract.ts)
   - 跨群聚合消息
   - 增量过滤（避免重复）
   - 分窗口 LLM 提取
   - 写入待审核表
   ↓
3. 人工审核 (review-qa.ts)
   - 批准 → 写入正式知识库
   - 拒绝 → 标记为拒绝
   - 跳过 → 保持待审核状态
   ↓
4. 验证完整性 (validate-extraction-coverage.ts)
   - 检查提取率
   - 发现时间缺口
   - 统计审核进度
```

## 数据库表说明

### message_processing_log
追踪每条消息的处理状态，避免重复提取。

### topic_extraction_metadata
记录每个主题的提取元数据（扫描范围、提取数量等）。

### knowledge_pending
待审核 Q&A 暂存表。

### knowledge_review_log
审核操作日志，记录谁在什么时间做了什么操作。

### knowledge
正式知识库（已审核通过的 Q&A）。

## 高级功能

### 模型配置

在 `.env` 中配置不同任务使用不同模型：

```bash
# 核心提取用高质量模型
MODEL_EXTRACTION=claude-opus-4-6-20260205
PROVIDER_EXTRACTION=anthropic

# 质量评分用廉价模型
MODEL_SCORING=MiniMax-M2.5-highspeed
PROVIDER_SCORING=minimax
```

### 提取版本控制

修改提取逻辑后，更新 `EXTRACTION_VERSION`：

```typescript
// scripts/incremental-extract.ts
const EXTRACTION_VERSION = 2; // 递增版本号
```

系统会自动重新提取所有消息。

### 定时任务

使用 cron 定时运行：

```bash
# 每天凌晨 2 点提取
0 2 * * * cd /path/to/project && npx tsx scripts/incremental-extract.ts

# 每天早上 9 点发送审核提醒
0 9 * * * cd /path/to/project && npx tsx scripts/send-review-reminder.ts
```

## 常见问题

### Q: 如何添加新主题？

编辑 `scripts/topics-config.ts`，添加新的主题配置，然后运行提取脚本。

### Q: 如何重新提取某个主题？

删除该主题的元数据记录：

```sql
DELETE FROM topic_extraction_metadata WHERE topic_name = 'FIX协议对接';
```

然后重新运行提取脚本。

### Q: 提取率太低怎么办？

1. 检查关键词是否准确
2. 优化 LLM prompt
3. 增加 `relatedGroups` 缩小搜索范围

### Q: 如何批量批准高质量 Q&A？

```sql
-- 自动批准评分 >= 4.0 的 Q&A
UPDATE knowledge_pending
SET review_status = 'approved'
WHERE auto_quality_score >= 4.0 AND review_status = 'pending';
```

## 性能优化

1. **并发提取** - 多个主题可以并行提取
2. **批量评分** - 关闭自动评分，手动批量评分
3. **缓存消息** - 缓存常用群组的消息列表

## 监控指标

- 提取率：Q&A 数 / 消息数（建议 > 1%）
- 审核率：已审核 / 待审核（建议 > 80%）
- 批准率：已批准 / 已审核（建议 > 60%）
- 时间覆盖：检查是否有大的时间缺口

## 下一步

1. 实现批量审核工具
2. 添加 Q&A 相似度检测
3. 集成飞书/企微通知
4. 实现 Web 审核界面
