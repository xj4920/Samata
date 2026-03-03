# Project Memory

## 环境规范
- 永远使用本地的 venv 环境执行 Python 命令（`source venv/bin/activate` 或使用 `venv/bin/python`）

## 数据注意事项
- InfluxDB（`messages` 库 `wework` 表）的 `time` 字段存储的是北京时间（CST），但标记为 UTC（`Z` 后缀）。实际 UTC = 存储时间 - 8 小时。做时间过滤时需加 8 小时偏移对齐。

## 架构规范

### 命令与工具复用
- Agent tools（`src/llm/agent.ts` 中的 tool handlers）必须复用 `src/commands/` 下已有的命令函数，禁止在 handler 中重新实现业务逻辑
- 命令函数应导出可复用的数据函数（如 `fetchTrades`），tool handler 只做薄包装：调用命令函数 → JSON.stringify 返回结果
- 新增 tool 时，先在 `src/commands/` 中实现并导出核心逻辑，再在 agent.ts 中添加 tool 定义和 handler 调用

### Bot 与 CLI 逻辑一致性（重要）
**原则：CLI 是标准实现，所有 bot（飞书、Telegram 等）必须与 CLI 保持完全一致**

#### Agentic Chat 逻辑共享
- **禁止**在 bot 中重复实现 agentic loop（tool use 循环）
- **必须**使用 `src/llm/agent.ts` 中的 `runAgenticChat()` 函数
- **必须**使用相同的 tools（通过 `getTools()`）和 system prompt（通过 `getSystemPrompt()`）

#### 正确的实现方式
```typescript
// ✅ 正确：飞书/Telegram bot 的 handleAIChat 实现
import { runAgenticChat } from '../llm/agent.js';

async function handleAIChat(userInput: string, userId: string, username: string): Promise<string> {
  const session = getSession(userId, username);

  // 临时切换用户上下文
  const prevUser = getCurrentUser();
  setCurrentUser(session.user);

  try {
    // 控制历史长度
    while (session.history.length > MAX_HISTORY * 2) {
      session.history.shift();
    }

    // 使用共享的 agentic chat 逻辑
    const textReply = await runAgenticChat(session.history, userInput, session.user, {
      streamEnabled: false,
      logPrefix: `[Bot:${username}] `,
      showThinking: true,
    });

    return textReply || '（无回复内容）';
  } finally {
    setCurrentUser(prevUser);
  }
}
```

#### 错误的实现方式
```typescript
// ❌ 错误：不要在 bot 中重复实现 agentic loop
async function handleAIChat(userInput: string): Promise<string> {
  // ❌ 不要手动实现 tool use 循环
  while (response.stop_reason === 'tool_use') {
    // ... 重复的逻辑
  }
}
```

#### 修改 Agentic 逻辑时
- 只需修改 `src/llm/agent.ts` 中的 `runAgenticChat()` 函数
- 所有入口（CLI、飞书、Telegram）会自动保持一致
- 无需在多个地方同步修改
