---
docModules:
  - plugins
docTopics:
  plugins: Skill 机制
canonicalDocs:
  - /plugins/sdk-and-lifecycle
status: implemented
---

# Skill 系统重构：向 Claude Code / openclaw 定义对齐

**日期：** 2026-03-31
**背景：** 当前 skill 系统是"prompt 宏命令"，与 Claude Code / openclaw 的"能力扩展"理念存在根本差异，需要重构对齐。

---

## 一、当前实现 vs 目标定义的本质差异

### 当前 otcclaw skill = 宏命令（Macro）

```
存储：SQLite DB，字段：id / name / prompt / agent_id / created_by
执行：用户调用 skill run → 替换 {param} → 发给 LLM 作为普通消息
注入：buildSystemPrompt() 把所有 skill 全文塞进 system prompt
```

**LLM 的角色：** 被动接收一条已替换好的字符串，凭记忆模仿 skill 格式。

### 目标 Claude Code / openclaw skill = 能力扩展（Capability）

```
存储：文件系统，SKILL.md（frontmatter + markdown 正文）
执行：内容注入 system prompt → LLM 主动决定何时用、怎么用
本质：教会 LLM 如何使用某个外部工具/CLI/流程
```

**LLM 的角色：** 主动学会一种新能力，自主判断场景并调用。

### 对比表

| 维度 | 当前 otcclaw | 目标（Claude 对齐） |
|------|-------------|-------------------|
| 本质 | prompt 模板字符串 | 能力说明文档（markdown） |
| 内容 | 短字符串 + {param} | 完整 markdown：用途/命令/示例/边界 |
| 执行触发 | 用户主动 `skill run` | LLM 自主判断场景后调用 |
| LLM 角色 | 被动接收消息 | 主动使用已学会的能力 |
| 参数化 | `{param}` 替换 | 无（LLM 自己从上下文提取参数） |
| 存储 | DB 单字段 prompt | 结构化文档（name/description/body） |
| 发现机制 | 全文注入 system prompt | 名称+描述注入，按需 get_skill |

---

## 二、问题诊断

### 问题 1：skill 全文注入 system prompt（`prompt.ts:66-71`）

```typescript
const skillList = skills.map(s => `- 「${s.name}」: ${s.prompt}`).join('\n');
base += `...${skillList}...`;
```

- 每次对话携带所有 skill 全文，不管是否用到
- skill 越多，context 越臃肿
- LLM 被要求"凭记忆进入技能模式"，不可靠

### 问题 2：无 `run_skill` 工具

LLM 有 `list_skills / get_skill / save_skill / delete_skill`，但**无法主动执行** skill。
要用 skill，只能靠 LLM 从 system prompt 里回忆格式，自己模仿输出。

### 问题 3：skill 内容结构单薄

当前只有一个 `prompt` 字段，缺少：
- `description`：供 LLM 判断"何时用这个 skill"
- 使用边界（何时不用）
- 具体命令/工具调用示例

### 问题 4：`parseKV` 不支持带空格的参数值

```typescript
/(\w+)=(\S+)/g  // "title=广发-磐松 北上" → title="广发-磐松"，"北上"丢失
```

### 问题 5：`UNIQUE(name)` 全局约束

不同 agent 不能拥有同名 skill（如 `tutor` 和 `alter-ego` 都想定义 `summary`）。

---

## 三、改进方案

### 3.1 DB Schema 扩展（`src/db/schema.ts`）

新增 migration `add-skills-description`：

```sql
ALTER TABLE skills ADD COLUMN description TEXT;
```

- `description`：一句话说明"何时用这个 skill"，注入 system prompt 用
- `prompt` 字段改语义：存完整的 markdown 能力说明（不再是短字符串模板）

同时新增 migration 修复 UNIQUE 约束：

```sql
-- 删除旧约束，改为 (name, COALESCE(agent_id, '')) 联合唯一
CREATE UNIQUE INDEX IF NOT EXISTS skills_name_agent_unique
  ON skills(name, COALESCE(agent_id, ''));
```

### 3.2 system prompt 注入改为轻量（`src/llm/agents/prompt.ts`）

**改前：**
```typescript
const skillList = skills.map(s => `- 「${s.name}」: ${s.prompt}`).join('\n');
// 全文注入
```

**改后：**
```typescript
const skillList = skills.map(s =>
  `- 「${s.name}」: ${s.description ?? s.prompt.slice(0, 60)}`
).join('\n');
base += `\n\n🛠️ **可用技能：**\n${skillList}\n\n使用 get_skill 获取完整内容，使用 run_skill 执行。`;
```

只注入名称 + 一句话描述，完整内容按需通过 `get_skill` 获取。

### 3.3 新增 `run_skill` 工具（`src/tools/skill-tools.ts`）

```typescript
{
  name: 'run_skill',
  description: '执行一个已保存的 skill。LLM 判断当前场景匹配某个 skill 时主动调用。',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'skill 名称' },
      params: {
        type: 'object',
        description: '传入 skill 的参数（key-value），用于替换 skill 内容中的 {param} 占位符',
        additionalProperties: { type: 'string' }
      },
    },
    required: ['name'],
  },
}
```

Handler 逻辑：
1. `getSkillByName(name, agentId)` 查 skill
2. 若有 `params`，执行 `resolvePrompt()` 替换占位符
3. 返回 resolved prompt 内容（LLM 在同一 agentic loop 继续处理）

### 3.4 修复 `parseKV` 支持引号（`src/commands/skill.ts`）

```typescript
// 改前
/(\w+)=(\S+)/g

// 改后：支持 key="value with spaces" 和 key=value
function parseKV(args: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of args.matchAll(/(\w+)="([^"]+)"|(\w+)=(\S+)/g)) {
    const key = m[1] ?? m[3];
    const val = m[2] ?? m[4];
    result[key] = val;
  }
  return result;
}
```

### 3.5 添加执行日志（`src/commands/skill.ts`）

在 `runSkill()` 执行前：
```typescript
recordEvent('skill', skill.id, 'run', { name, params });
```

---

## 四、Skill 内容规范（对齐 Claude 理念）

改造后，skill 的 `prompt` 字段应存储结构化 markdown，而非短字符串：

```markdown
## 何时使用
✅ 用户要求查看交易日报、按管理人汇总成交数据时
❌ 不用于实时行情查询、客户状态变更

## 执行步骤
1. 调用 fetch_trades 获取 {date} 的成交数据
2. 按管理人分组汇总
3. 按以下格式输出表格：...

## 输出格式
| 管理人 | 成交笔数 | 成交金额 | 占比 |
```

`description` 字段存一句话摘要，用于 system prompt 注入：
```
"按管理人汇总指定日期的交易日报"
```

---

## 五、实施顺序

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1 | `src/db/schema.ts` | 新增 `description` 字段 migration + 修复 UNIQUE 约束 |
| 2 | `src/commands/skill.ts` | `saveSkill` 支持 `description` 参数；修复 `parseKV`；`runSkill` 加执行日志 |
| 3 | `src/tools/skill-tools.ts` | 新增 `run_skill` 工具；`save_skill` 支持 `description` 字段 |
| 4 | `src/llm/agents/prompt.ts` | system prompt 改为轻量注入（名称+描述） |
| 5 | `src/llm/agents/config.ts` | TOOL_PRESETS `common` 中加入 `run_skill` |

---

## 六、验证方式

1. `skill save test_skill "## 何时使用\n✅ 测试场景" --description "测试用 skill"`
2. 对话中说"帮我跑一下 test_skill"，观察 LLM 是否主动调用 `run_skill` 工具
3. 确认 system prompt 中只有 skill 名称+描述，不含全文
4. `skill run test_skill param="带空格的值"` 验证 parseKV 修复
5. 两个不同 agent 各自保存同名 skill，验证 UNIQUE 约束修复
