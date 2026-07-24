# Dream 机制：Agent 夜间自省与经验沉淀

## 概述

Dream 是 Samata 的"夜间自省"机制——模拟人类睡眠时整理记忆的过程。每个 agent 在凌晨自动复盘前一天的工具使用数据，从中提炼出可长期复用的经验法则，注入 system prompt 供后续对话参考。

## 数据流

```
telemetry_turn (SQLite)           ← 白天：每次对话自动记录工具调用链
       │
       │  主进程内调度器：凌晨 3:00
       ▼
src/services/dream-scheduler.ts   ← cron-parser 计算下次执行时间并加本地锁
       │
       ▼
src/services/dream-analyze.ts     ← 查询遥测 → 构建回放 → LLM 提炼
       │
       ▼
data/dreams/{agent}/{date}.md     ← 输出：经验文件
       │
       │  每次对话构建 system prompt 时
       ▼
config/agents/{agent}.md          ← {{dream}} 占位符被替换
       │
       ▼
agent system prompt               ← 经验注入，agent 变得更聪明
```

## 以 OTCCLAW（衍语）为例

### 1. 遥测数据采集

otcclaw 在白天处理用户请求时，每个对话轮次的工具调用被记录到 `telemetry_turn` 表：

| 字段 | 说明 |
|------|------|
| agent_id | `'otcclaw'` |
| channel | `'feishu'` / `'wework'` / `'cli'` 等 |
| loop_rounds | agentic loop 轮数（越高说明探索越多） |
| tools_json | 工具调用链 JSON 数组，每个元素含 name、input、output_preview、success、error |
| answer_preview | 最终回复摘要 |
| user_question | 用户原始问题 |

例如用户问"全利昨天加仓了多少"，tools_json 记录的调用链：
```
calculate_date → query_trades(client:"全利") → [未查询到] ✗
→ list_customers → [全利→PANTHEON] → query_trades(party:"PANTHEON") → [成功] ✓
```

### 2. Dream 调度触发

OtcClaw 主进程启动时由 `src/index.ts` 调用 `startDreamScheduler()`。调度器默认按
`0 3 * * *`、`Asia/Chongqing` 计算下一次执行时间，触发后分析北京时间前一天数据；
`data/dreams/.dream-scheduler.lock` 防止重复执行。因此 Dream 当前依赖主 OtcClaw 进程
持续运行，不依赖宿主机 crontab，也没有独立 sidecar。

可以通过环境变量覆盖或关闭：

```bash
DREAM_CRON_EXPR='0 3 * * *'
DREAM_TIMEZONE='Asia/Chongqing'
DREAM_SCHEDULER_DISABLED=1
```

也可手动指定日期执行分析入口：
```bash
npx tsx scripts/dream.ts 2026-05-12
```

脚本会遍历所有 agent，逐个执行 dream 分析。

### 3. 回放构建与分类

`buildToolUsageSummary()` 将 otcclaw 当天所有 turn 分为两类：

**有探索/失败的交互（重点分析）** — loop > 3 轮或有工具调用失败：
```
=== 有探索/失败的交互（重点分析） ===

[Turn] 用户场景: 全利昨天加仓了多少？
  calculate_date({"operation":"now"}) → {"date":"2026-05-12"} ✓
  query_trades({"client":"全利","date":"20260511"}) → "未查询到" ✗
  list_customers({}) → [全利→PANTHEON映射] ✓
  query_trades({"party":"PANTHEON","date":"20260511"}) → [成功] ✓
```

**顺利完成的交互（参考）** — 低轮次且全部成功：
```
=== 顺利完成的交互（参考） ===
- query_clients → view_client
- search_knowledge
```

### 4. LLM 提炼经验

将以下内容拼接为 user message 发送给 LLM：
1. 数据日期 + Agent 名称
2. 工具使用回放（上一步构建的摘要）
3. 现有历史经验（若有，标注"新数据与之矛盾时以新数据为准"）

LLM 按 `DREAM_SYSTEM_PROMPT` 的约束提炼，核心要求：
- 每条经验必须包含"场景 → 正确做法"因果结构
- 聚焦从失败→成功的路径提炼：参数修正策略、降级路径、工具链组合
- 禁止出现延时数值、调用次数等运营指标
- 禁止使用"今日/今天"等时效性措辞
- 新数据与旧经验矛盾时以新数据为准

可通过 `DREAM_PROVIDER` / `DREAM_MODEL` 环境变量指定专用模型，与对话模型解耦。

### 5. 质量校验

写入前 `validateDream()` 自动检查：

| 检查项 | 规则 |
|--------|------|
| 延时数值 | 不含 `\d+ms` 等 |
| 运营指标 | 不含"N次调用/失败/成功" |
| 时效措辞 | 不含"今日/今天/本日/本次" |
| 标准开头 | 以 `## 工具使用经验` 起始 |
| 工具分节 | 包含 `###` 分节标记 |

任何一项不通过则**拒绝写入**，避免低质量内容污染经验库。

### 6. 文件输出

通过校验后写入 `data/dreams/otcclaw/2026-05-12.md`。

以下是 otcclaw 实际生成的 dream 节选——可以看到它从真实的工具调用回放中提炼出了多条高价值经验：

```markdown
### sandbox_exec
- 场景：需要多步计算、数据清洗或生成图表时。
- 正确做法：将所有处理逻辑合并为单个 Python 脚本一次执行，脚本末尾必须包含
  try/except 和关键结果 print，并用 os.path.exists() 自检所有生成文件。
- 所有文件操作必须使用沙箱内部绝对路径，严禁 /tmp 或任何沙箱外路径。

### 客户/管理人名称映射（query_trades + query_clients + list_customers）
- 场景：用户提供的中文简称与系统内标准名称不一致，导致 query_trades 返回"未找到"。
- 正确做法：立即停止对同一错误名称的重试。先读取错误信息中的可用列表，或主动调用
  list_customers 获取全量清单，结合关键词匹配定位系统标准名称。
- 典型错误：连续多次用同一个不存在的名称调用 query_trades，严重拖慢进度。
```

### 7. 注入 System Prompt

otcclaw 的 prompt 模板 `config/agents/otcclaw.md` 中有 `{{dream}}` 占位符。每次对话时，`buildSystemPrompt()` 的处理流程：

1. `buildDreamBlock('otcclaw')` 调用 `loadDreamFile('otcclaw')`
2. 读取 `data/dreams/otcclaw/` 目录下按文件名排序的最后一个 `.md` 文件（即最新日期）
3. 将内容替换到模板中的 `{{dream}}` 位置

这样 otcclaw 在下一次处理类似问题时，system prompt 中已经包含了"先查映射再查交易"、"沙箱路径必须用内部路径"等经验，不会再走弯路。

### 8. 增量进化

Dream 采用增量合并策略：

| 情况 | 处理方式 |
|------|----------|
| 新数据验证旧经验正确 | 保留，精简措辞 |
| 新数据揭示未覆盖场景 | 新增条目 |
| 新数据与旧经验矛盾 | 以新数据为准，覆盖旧经验 |
| 旧经验未被新数据涉及 | 原样保留 |

随着时间推移，otcclaw 的 dream 文件会越来越精准地反映 OTC 业务场景下的工具使用最佳实践。

## 关键设计决策

| 决策 | 理由 |
|------|------|
| 文件存储而非 DB | dream 是 prompt 的一部分，纯文本易 git 管理和人工审阅 |
| per-agent 隔离 | otcclaw 的金融工具经验不应污染 ticlaw 的研发工具经验 |
| 独立 LLM 配置 | dream 分析可用低成本模型，不必与对话用同一个 |
| 质量校验门控 | 宁可不写也不写垃圾，保证经验库质量 |
| 按日期子目录 | `data/dreams/otcclaw/2026-05-12.md` 方便追溯和 diff |
| 长度预警 6000 字符 | 超限时 warn，避免 system prompt 上下文窗口膨胀 |

## 相关文件索引

| 文件 | 职责 |
|------|------|
| `src/services/dream-scheduler.ts` | 主进程内每日调度、锁和失败处理 |
| `scripts/dream.ts` | 指定日期手动执行入口 |
| `src/services/dream-analyze.ts` | 核心分析引擎（查询、回放构建、LLM 调用、校验、写入） |
| `src/llm/agents/prompt.ts` | system prompt 构建，`{{dream}}` 占位符替换 |
| `src/llm/provider.ts` | `getDreamProvider()` 提供独立 LLM 配置 |
| `config/agents/*.md` | agent prompt 模板，含 `{{dream}}` 占位符 |
| `data/dreams/{agent}/{date}.md` | dream 输出文件 |
