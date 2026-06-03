---
docModules:
  - dream
docTopics:
  dream: 质量与观测
canonicalDocs:
  - /dream/quality
status: implemented
---

# 丰富 Dream 数据源 + 改善提取质量

## 背景问题

当前 dream 输出充斥无营养内容：
1. "平均响应 7ms，今日 4 次调用零失败" — 运营指标无长期价值
2. 满篇"今日"字眼 — dream 是长期复用的经验手册，不是日报
3. 只有聚合统计，缺失"从错误尝试中提炼高效使用"的核心价值

根因：`TelemetryToolCall` 只记录 name/duration/success/error，丢失了"用什么参数调的、返回了什么"。LLM 拿不到交互细节，只能照搬数字。

## 方案：丰富 telemetry 采集 + 重写 prompt

### 改动 1：TelemetryToolCall 类型加字段

文件：`src/telemetry/types.ts`

```typescript
export interface TelemetryToolCall {
  name: string;
  round: number;
  duration_ms: number;
  success: boolean;
  bytes: number;
  error?: string;
  input?: string;          // 新增：JSON.stringify(block.input)，截断 500 字符
  output_preview?: string; // 新增：result 截断 300 字符
}
```

无需改 DB schema — `tools_json` 是 TEXT 列存 JSON，新字段自动序列化。

### 改动 2：agent.ts 采集时传入 input/output

文件：`src/llm/agent.ts` 第 975 行附近

```typescript
recordTool(telemetrySessionId, {
  name: block.name,
  round,
  duration_ms: toolDuration,
  success: !toolError,
  bytes: Buffer.byteLength(result, 'utf-8'),
  error: toolError,
  input: JSON.stringify(block.input).slice(0, 500),
  output_preview: result.slice(0, 300),
});
```

`block.input` 和 `result` 在该作用域内已可用。

### 改动 3：重写 buildToolUsageSummary()

文件：`src/services/dream-analyze.ts` 第 95-153 行

当前输出聚合统计，改为**按 turn 回放交互链路**：

```
[Turn] 用户问题: "全利昨天加仓了多少？"
  round1: calculate_date({operation:"now"}) → {date:"2026-05-12"} ✓
  round2: query_trades({client:"全利",date:"20250511"}) → "未查询到" ✗
  round3: list_customers({}) → [全利→PANTHEON映射] ✓
  round4: query_trades({party:"PANTHEON",date:"20260511"}) → [成功] ✓
```

- 有失败或高轮次(>3)的 turn：输出完整 tool chain
- 全成功低轮次的 turn：只输出一行摘要
- 不再输出调用次数、平均延时

### 改动 4：重写 DREAM_SYSTEM_PROMPT

同文件第 155-164 行，关键约束：

- **禁止**输出延时(ms/s)、调用次数、成功率等运营指标
- **禁止**"今日"、"今天"、"本日"等时效性措辞
- **聚焦**从失败→成功的路径提炼：参数修正策略、降级路径、工具链组合
- **要求**每条经验包含"场景 → 正确做法"因果结构

### 改动 5：中性化 userMessage 模板

同文件第 177-185 行：
- `今日日期` → `数据日期`
- `今日工具使用数据` → `工具使用回放`

### 验证

重跑 `npx tsx scripts/dream.ts 2026-05-11`，确认：
- 无 ms/次数指标
- 无"今日"字眼
- 包含具体参数调整策略和错误恢复路径

注意：历史数据无 input/output_preview 字段，buildToolUsageSummary 需兼容 undefined（降级为只输出工具名+成功/失败）。
