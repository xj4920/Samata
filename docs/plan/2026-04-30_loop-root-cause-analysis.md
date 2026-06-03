---
docModules:
  - platform
  - external-data
docTopics:
  platform: 观测与稳定性
  external-data: Web 与浏览器
canonicalDocs:
  - /platform/observability
  - /external-data/web-and-browser
status: implemented
---

# 2026-04-29 异常会话根因分析

## 现象

53 次会话中 22 次 (41.5%) 未正常返回答案。全部发生在企微渠道的 `agent-otcclaw`。

## 根因（共 4 层，从上到下递进）

### 1. `search_knowledge` 工具描述**主动引导了重试**

`src/tools/knowledge-tools.ts:12`:
```
'如果首次搜索无结果，尝试减少关键词或换用同义词。'
```

这告诉 LLM "搜不到就换词继续搜"。LLM 忠实地执行了这个指令——icoleqiu 的 8 次 search_knowledge 循环都是换不同关键词反复搜索，但知识库里确实没有相关内容，最终烧光 30 轮工具预算。

### 2. Loop detector 基于参数 fingerprint，换关键词就绕过了

`src/llm/agent.ts:274-277`:
```typescript
function fingerprint(input: unknown): string {
  if (typeof input !== 'object' || input === null) return JSON.stringify(input);
  return JSON.stringify(input, Object.keys(input as Record<string, unknown>).sort());
}
```

`detectLoop()` 只在**同一工具 + 同一参数**在最近 12 次调用中出现 ≥4 次时才触发。icoleqiu 每次换不同关键词搜，fingerprint 不同，loop detector **检测不到**。只有当模型碰巧用了之前用过的同一个关键词时，才在 12-20 轮后被 hard_stop。

日志证据：
```
[WARN] 检测到循环: search_knowledge 重复调用，注入自我反思提示
```
icoleqiu 的 search_knowledge 循环触发了 4 次 warn，说明模型在大量不同关键词中**偶尔**重复了参数，才被捕捉到。

### 3. Agent prompt 没有"何时停止搜索"的指引

`config/agents/otcclaw.md` 没有任何关于搜索上限的约束。LLM 不知道应该在搜 2-3 次无果后告知用户"知识库中未找到相关内容"。

对比：prompt 里对 `query_clients` 有明确的约束（"禁止使用空参数查询"），对文件发送有约束（"发送完成后任务即结束，不要重复修改和重发"），但对 `search_knowledge` **没有任何限制**。

### 4. MAX_TOOL_ROUNDS=30 太高，soft_warn 经常被 LLM 无视

`src/llm/agent.ts:96-99`:
```typescript
const MAX_TOOL_ROUNDS = 30;
```

soft_warn 注入的消息（line 876）：
```
⚠️ 系统检测到你最近 4 次调用了同一工具 "search_knowledge" 且参数几乎相同...
请停止使用这个工具，基于当前已有的信息直接给出答复。
```

但实际上 LLM 经常**无视**这条消息，继续尝试其他工具（或换参数继续搜）。等到 hard_stop 触发时，已经浪费了大量 token。icoleqiu 最严重的一次消耗了 707k 输入 token（#39）。

### 其他工具的同类问题

| 工具 | 循环次数 | 根因 |
|------|---------|------|
| `sandbox_exec` | 3 | Python 代码执行失败后反复修改重试，未限定重试次数 |
| `send_file` | 2 | 发送失败后反复重试，未检查文件是否已存在/已发送 |
| `import_document` | 2 | 导入失败后反复重试同一文件 |
| `parse_word` | 2 | 解析失败后反复重试 |

这些问题共享同一个根因：**工具层面没有"失败就停"的约束，prompt 层面也没有"重试上限"的指引**。

## 可修复点（按优先级）

1. **修复 `search_knowledge` 描述** — 删掉"换用同义词"引导，改为"搜索 2-3 次无结果应告知用户"
2. **agent prompt 增加搜索上限约束** — "同一问题最多搜索知识库 3 次，仍未找到则告知用户暂无相关文档"
3. **降低 MAX_TOOL_ROUNDS** — 从 30 降到 20，或对 search_knowledge 类只读工具单独限制
4. **增强 loop detector** — 增加"同工具 + 不同参数但同类别"的频率检测（如同一工具在 N 轮内被调用超过阈值即告警，不论参数是否相同）
