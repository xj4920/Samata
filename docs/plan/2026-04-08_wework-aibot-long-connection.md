# 企微智能机器人：长连接接入（详细实施方案）

对应官方文档 [智能机器人长连接 101463](https://developer.work.weixin.qq.com/document/path/101463)，SDK 文档 [aibot-node-sdk](https://github.com/WecomTeam/aibot-node-sdk)。

## 可行性评估

**结论：完全可行。** 理由：

1. **SDK 已就绪**：`@wecom/aibot-node-sdk@^1.0.6` 已在 `package.json`（仅未 import）；SDK 提供 `WSClient` 类，封装了连接认证、心跳保活、断线重连、消息分发、流式回复全链路。
2. **架构对齐**：飞书 bot 已经使用相同模式（`Lark.WSClient` 长连接 → 事件分发 → `runAgenticChat`），企微只需复刻这个模式。
3. **无公网依赖**：长连接模式出站连接 `wss://openws.work.weixin.qq.com`，无需配置回调 URL、nginx 反代、公网 IP。
4. **凭证简单**：仅需 `botId` + `secret`（环境变量），比 webhook 的 token/aesKey/corpId 更轻量。
5. **流式回复原生支持**：SDK `replyStream(frame, streamId, content, finish)` 天然适配 `runAgenticChat` 的 `onTextChunk` 回调。

---

## 目标

- 使用 `@wecom/aibot-node-sdk` 的 `WSClient` 建立 WebSocket 长连接。
- **完全移除** webhook 专用代码（XML 解析、AES 加解密、被动回复、HTTP 路由等）。
- WeWork 作为与 feishu、cli、telegram **同等地位的 channel**，交互模式对齐飞书 bot。
- 凭证通过环境变量 `WEWORK_AIBOT_BOT_ID` + `WEWORK_AIBOT_SECRET` 注入。

---

## 删除清单

| 移除 | 说明 |
|------|------|
| `src/wework/api.ts` | XML 解析、echostr、AES 加解密、被动回复、`sendTextMessage` 等 webhook 逻辑 |
| `src/wework/crypto.ts` | 仅被 `api.ts` 使用的 AES/SHA1/PKCS7 |
| `handleWebhookRequest` | 从 `src/wework/bot.ts` 删除 |
| `src/wework-entry.ts` 中 HTTP 回调逻辑 | 删除非 `/health` 的 webhook 路由代码；保留 `/health` 端点 |
| `config/monitor.json.example` 中 `wework.token`/`aesKey`/`encryptEnabled` | 替换为说明使用环境变量 |

---

## 实现详情

### 1. 新模块 `src/wework/aibot-ws.ts`

WebSocket 客户端封装，职责等同于飞书的 `Lark.WSClient` 使用方式。

```typescript
import AiBot from '@wecom/aibot-node-sdk';
import type { WsFrame } from '@wecom/aibot-node-sdk';
import { generateReqId } from '@wecom/aibot-node-sdk';
import { log } from '../utils/logger.js';

let wsClient: InstanceType<typeof AiBot.WSClient> | null = null;

export function createWsClient(botId: string, secret: string) {
  wsClient = new AiBot.WSClient({
    botId,
    secret,
    maxReconnectAttempts: -1,  // 无限重连
    logger: {
      debug: (...args) => log.dim(`[企微WS] ${args.join(' ')}`),
      info:  (...args) => log.info(`[企微WS] ${args.join(' ')}`),
      warn:  (...args) => log.warn(`[企微WS] ${args.join(' ')}`),
      error: (...args) => log.error(`[企微WS] ${args.join(' ')}`),
    },
  });
  return wsClient;
}

export function getWsClient() { return wsClient; }
export { generateReqId };
export type { WsFrame };
```

### 2. 重写 `src/wework/bot.ts`

对齐飞书 bot 模式：`runWithExecutionContext({ channel: 'wework' })`、`onProgress`、`deliveryContext`、流式回复。

**核心消息处理流程**（伪代码）：

```typescript
import { runWithExecutionContext } from '../runtime/execution-context.js';
import { runAgenticChat, type ProgressEvent, type DeliveryContext } from '../llm/agent.js';
import { createWsClient, getWsClient, generateReqId, type WsFrame } from './aibot-ws.js';
import { getSession, resetSession, cleanupSessions } from './session.js';

async function handleTextMessage(frame: WsFrame): Promise<void> {
  return runWithExecutionContext({ channel: 'wework' }, async () => {
    const { chattype, chatid, from } = frame.body;
    const userId = from.userid;
    const isGroup = chattype === 'group';
    const text = (frame.body.text?.content || '').replace(/@\S+\s?/g, '').trim();
    if (!text) return;

    const mapKey = isGroup ? `g:${chatid}:${userId}` : userId;
    const username = `wework_${userId.slice(-6)}`;

    // 检查 slash command
    if (text.startsWith('/')) {
      const reply = await handleSlashCommand(text, mapKey, userId, username);
      if (reply) {
        await getWsClient()!.replyStream(frame, generateReqId('stream'), reply, true);
        return;
      }
    }

    // AI 对话：流式回复
    const session = getSession(mapKey, username);
    const prevUser = getCurrentUser();
    setCurrentUser(session.user);
    try {
      const agentConfig = getAgent(session.agentName);
      const streamId = generateReqId('stream');
      const ws = getWsClient()!;

      // 发送"思考中"占位
      await ws.replyStream(frame, streamId, '思考中...', false);

      let lastStreamContent = '';
      const THROTTLE_MS = 800;
      let lastChunkTime = 0;

      const onProgress = (event: ProgressEvent) => {
        const now = Date.now();
        if (now - lastChunkTime < THROTTLE_MS) return;
        lastChunkTime = now;

        let hint = '';
        if (event.type === 'tool_start') hint = `正在调用 ${event.name}...`;
        else if (event.type === 'thinking') hint = event.text.slice(0, 200);

        if (hint && hint !== lastStreamContent) {
          lastStreamContent = hint;
          ws.replyStream(frame, streamId, hint, false).catch(() => {});
        }
      };

      const textReply = await runAgenticChat(session.history, text, session.user, {
        streamEnabled: false,
        logPrefix: `[企微:${username}] `,
        showThinking: true,
        agentConfig,
        onProgress,
        deliveryContext: { channel: 'wework' } as DeliveryContext,
      });

      // finish=true 发送最终结果
      const finalText = textReply || '（无回复内容）';
      await ws.replyStream(frame, streamId, finalText, true);
    } finally {
      setCurrentUser(prevUser);
    }
  });
}
```

**关键对齐点（vs 飞书）**：

| 维度 | 飞书 | 企微（本方案） |
|------|------|------------|
| 执行上下文 | `runWithExecutionContext({ channel: 'feishu' })` | `runWithExecutionContext({ channel: 'wework' })` |
| Agent 解析 | `resolveAgent('feishu', feishuUserId)` → session | `resolveAgent('wework', userId)` → session |
| 用户身份 | `feishu_{userId}` | `wework_{userId}` |
| 进度展示 | `onProgress` → `buildThinkingCard` → `updateCard` | `onProgress` → `replyStream(finish=false)` 刷新流式消息 |
| 最终回复 | `buildCard(text)` → `sendCard` / `replyMessage` | `replyStream(frame, streamId, text, true)` |
| `deliveryContext` | `{ channel: 'feishu', targetId, appId }` | `{ channel: 'wework' }` |
| 流式 | `streamEnabled: false` + card 更新模拟 | `streamEnabled: false` + `replyStream` 刷新模拟 |

### 3. 会话管理 `src/wework/session.ts`

扩展 `getSession` 签名以支持群聊键：

```typescript
// mapKey: 单聊时 = userId，群聊时 = "g:{chatid}:{userid}"
// bindingUserId: 始终为成员 userid，用于 resolveAgent
export function getSession(mapKey: string, weworkUsername: string): WeworkSession {
  let session = sessions.get(mapKey);
  if (!session) {
    // 从 mapKey 提取真实 userId 用于 agent 解析
    const bindingUserId = mapKey.startsWith('g:') ? mapKey.split(':')[2] : mapKey;
    const agent = resolveAgent('wework', bindingUserId);
    ...
    sessions.set(mapKey, session);
  }
  ...
}
```

### 4. 欢迎语

```typescript
wsClient.on('event.enter_chat', async (frame: WsFrame) => {
  const agentConfig = resolveDefaultAgent();
  const welcomeText = agentConfig
    ? `您好！我是${agentConfig.displayName}，有什么可以帮您的？`
    : '您好！有什么可以帮您的？';

  await wsClient.replyWelcome(frame, {
    msgtype: 'text',
    text: { content: welcomeText },
  });
});
```

### 5. 生命周期 `startWeworkBot` / `stopWeworkBot`

```typescript
export async function startWeworkBot(): Promise<void> {
  if (running) return;

  const botId = process.env.WEWORK_AIBOT_BOT_ID;
  const secret = process.env.WEWORK_AIBOT_SECRET;
  if (!botId || !secret) {
    log.warn('[企微] 未配置 WEWORK_AIBOT_BOT_ID 或 WEWORK_AIBOT_SECRET，跳过启动');
    return;
  }

  const ws = createWsClient(botId, secret);

  ws.on('authenticated', () => log.success('[企微] WebSocket 认证成功'));
  ws.on('disconnected', (reason) => log.warn(`[企微] WebSocket 断开: ${reason}`));
  ws.on('reconnecting', (attempt) => log.info(`[企微] 正在重连 (第 ${attempt} 次)...`));
  ws.on('error', (err) => log.error(`[企微] WebSocket 错误: ${err.message}`));

  ws.on('message.text', (frame) => handleTextMessage(frame).catch(err =>
    log.error(`[企微] 处理文本消息出错: ${err.message}`)
  ));

  ws.on('event.enter_chat', handleEnterChat);

  ws.connect();
  running = true;

  cleanupTimer = setInterval(() => {
    const cleaned = cleanupSessions();
    if (cleaned > 0) log.dim(`[企微] 清理过期会话: ${cleaned} 个`);
  }, 30 * 60 * 1000);

  log.success('[企微] Bot 已启动（WebSocket 长连接模式）');
}

export function stopWeworkBot(): void {
  const ws = getWsClient();
  if (ws) ws.disconnect();
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
  running = false;
  log.info('[企微] Bot 已停止');
}

export function isWeworkBotRunning(): boolean {
  return running && (getWsClient()?.isConnected ?? false);
}
```

### 6. 入口 `src/wework-entry.ts` 简化

```typescript
import 'dotenv/config';
import { createServer } from 'node:http';
import { initSchema } from './db/schema.js';
import { initProviders } from './llm/provider.js';
import { setCurrentUser } from './auth/rbac.js';
import { closeDb } from './db/connection.js';
import { startWeworkBot, stopWeworkBot } from './wework/bot.js';
import { log } from './utils/logger.js';

const PORT = parseInt(process.env.WEWORK_PORT || '3002', 10);

async function main() {
  initSchema();
  await initProviders();
  setCurrentUser({ id: 'admin-001', username: 'admin', role: 'admin' });

  await startWeworkBot();

  // 仅保留健康检查 HTTP 端点（可选）
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(PORT, () => log.success(`企微 Bot 健康检查: http://localhost:${PORT}/health`));

  const shutdown = () => {
    stopWeworkBot();
    server.close(() => { closeDb(); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
```

### 7. 主进程集成（`src/index.ts`）

在 `startMonitor({ auto: true })` 后面添加企微 bot 启动，与飞书并列：

```typescript
// 启动企微机器人（长连接模式）
await startWeworkBot();

// 启动飞书机器人
await startAllFeishuBots({ ... });
```

`gracefulShutdown` 中同样调用 `stopWeworkBot()`。

### 8. 环境变量

`.env` 或部署环境中添加：

```
WEWORK_AIBOT_BOT_ID=xxx
WEWORK_AIBOT_SECRET=xxx
```

`config/monitor.json.example` 中 `wework` 块简化为：

```json
{
  "wework": {
    "_note": "企微长连接凭证通过环境变量 WEWORK_AIBOT_BOT_ID / WEWORK_AIBOT_SECRET 配置"
  }
}
```

---

## 与飞书 channel 的一致性保障

| 规范点 | 实现 |
|--------|------|
| `AppChannel` 类型 | `execution-context.ts` 已有 `'wework'`，无需修改 |
| `runWithExecutionContext` | 所有消息/事件处理包裹在 `{ channel: 'wework' }` 中 |
| 权限隔离 | `getExecutionChannel() !== 'cli'` → bot channel 拒绝管理操作 |
| Agent 解析 | `resolveAgent('wework', userId)`，与飞书 `resolveAgent('feishu', userId)` 对称 |
| `runAgenticChat` 复用 | 直接调用共享函数，传递 `onProgress` + `deliveryContext` |
| Session 模式 | `Map<mapKey, WeworkSession>`，与飞书 `instance.sessions` 对称 |
| 命令路由 | `/command` 走 `handleCommand`，自然语言走 `runAgenticChat`，与飞书一致 |

---

## 验收

- `npm run wework` 启动后仅维持 WebSocket 长连接 + 可选 `/health` HTTP，无回调 URL。
- 单聊/群聊(@bot)文本走原有命令和 `runAgenticChat`。
- 流式消息正常刷新（思考中 → 工具调用 → 最终结果）。
- 仓库无真实 Bot Secret、无 webhook 专用代码。
- `getExecutionChannel()` 在 wework handler 中返回 `'wework'`。

---

## 不在本次范围

- 图片/文件/语音/视频消息处理（可用 `wsClient.downloadFile` + `uploadMedia` 后续迭代）。
- 模板卡片交互（`event.template_card_event`）。
- 主动推送消息（`wsClient.sendMessage`）—— 可作为后续告警推送场景。

---

## 实施顺序

1. `npm install @wecom/aibot-node-sdk`（确认已安装）
2. 新建 `src/wework/aibot-ws.ts`
3. 重写 `src/wework/bot.ts`（删除 webhook，新增 WS 事件处理）
4. 更新 `src/wework/session.ts`（支持群聊键）
5. 简化 `src/wework-entry.ts`
6. 删除 `src/wework/api.ts`、`src/wework/crypto.ts`
7. 在 `src/index.ts` 中集成 `startWeworkBot` / `stopWeworkBot`
8. 更新 `config/monitor.json.example`
9. 本地测试：配置 env → `npm run wework` → 企微发消息验证
