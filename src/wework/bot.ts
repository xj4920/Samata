/**
 * 企业微信 Bot（WebSocket 长连接模式）
 *
 * 多实例架构：每个企微 bot 应用独立运行（独立 WSClient、会话、Agent 绑定），
 * 与飞书 bot 同等地位的 channel。
 *
 * 消息处理流程：
 * 1. /command → 直接调用命令函数，不经过 LLM
 * 2. 自然语言 → runAgenticChat()
 */
import type { WSClient, WsFrame, WsFrameHeaders, TextMessage, ImageMessage, MixedMessage, FileMessage, EventMessageWith, EnterChatEvent } from '@wecom/aibot-node-sdk';
import { createWsClient, generateReqId } from './aibot-ws.js';
import { getSession, resetSession, cleanupSessions, type WeworkSession } from './session.js';
import { isAgentAdmin } from '../auth/rbac.js';
import { runAgenticChat, setCurrentAgent, detectImageMediaType, type ImageInput, type ProgressEvent } from '../llm/agent.js';
import { getAgent, getDefaultAgent, resolveAgent, AgentUnboundError, getBotAppsByChannel, type DeliveryContext, type BotAppRow } from '../llm/agents/config.js';
import { runWithExecutionContext } from '../runtime/execution-context.js';
import { log } from '../utils/logger.js';
import { getCommandEntries } from '../commands/router.js';
import { fetchSystemStatus, formatSystemStatus } from '../commands/monitor.js';
import { fetchKnowledge } from '../commands/knowledge.js';
import { getAllSkills } from '../commands/skill.js';
import {
  formatKnowledge, formatSkillList,
} from './formatter.js';
import { getProviderName, getModelName, switchProvider, getAvailableProviders, type ProviderName } from '../llm/provider.js';
import { getDb } from '../db/connection.js';
import { saveUploadedFile } from '../commands/artifact.js';

interface WeworkBotInstance {
  botId: string;
  botName: string;
  wsClient: WSClient;
  sessions: Map<string, WeworkSession>;
  cleanupTimer: ReturnType<typeof setInterval> | null;
}

const botInstances = new Map<string, WeworkBotInstance>();

// --- Image download helper ---

async function downloadWeworkImage(
  ws: WSClient, url: string, aeskey?: string, logTag?: string,
): Promise<ImageInput | null> {
  try {
    const { buffer } = await ws.downloadFile(url, aeskey);
    log.dim(`${logTag} 下载图片成功 (${buffer.length} bytes)`);
    return { data: buffer.toString('base64'), mediaType: detectImageMediaType(buffer) };
  } catch (err: any) {
    log.error(`${logTag} 下载图片失败: ${err.message}`);
    return null;
  }
}

// --- Message Handling (instance-scoped) ---

function handleTextMessageForInstance(instance: WeworkBotInstance, frame: WsFrame<TextMessage>): Promise<void> {
  return runWithExecutionContext({ channel: 'wework' }, async () => {
    const body = frame.body!;
    const userId = body.from.userid;
    const isGroup = body.chattype === 'group';
    const text = (body.text?.content || '').replace(/@\S+\s?/g, '').trim();
    if (!text) return;

    const mapKey = isGroup ? `g:${body.chatid}:${userId}` : userId;
    const username = `wework_${userId.slice(-6)}`;

    log.dim(`[企微:${instance.botName}] ${username}: ${text.slice(0, 80)}`);

    let reply = '';

    try {
      if (text.startsWith('/')) {
        const slashReply = await handleSlashCommand(instance, text, mapKey, userId, username);
        if (slashReply) {
          const streamId = generateReqId('stream');
          await instance.wsClient.replyStream(frame, streamId, slashReply, true);
          return;
        }
      }

      reply = await handleAIChat(instance, frame, text, mapKey, userId, username);
    } catch (err: any) {
      if (err instanceof AgentUnboundError) {
        log.warn(`[企微:${instance.botName}] ${err.message}`);
        reply = `⚠️ ${err.message}`;
      } else {
        log.error(`[企微:${instance.botName}] 处理消息出错: ${err.message}`);
        reply = `处理出错: ${err.message}`;
      }
      const streamId = generateReqId('stream');
      await instance.wsClient.replyStream(frame, streamId, reply, true);
    }
  });
}

async function handleAIChat(
  instance: WeworkBotInstance,
  frame: WsFrameHeaders,
  userInput: string,
  mapKey: string,
  userId: string,
  username: string,
  images?: ImageInput[],
): Promise<string> {
  const session = getSession(instance.botId, instance.sessions, mapKey, username);

  return runWithExecutionContext({ channel: 'wework', user: session.user }, async () => {
    const agentConfig = getAgent(session.agentName);

    const MAX_HISTORY = 20;
    while (session.history.length > MAX_HISTORY * 2) {
      session.history.shift();
    }

    const ws = instance.wsClient;
    const streamId = generateReqId('stream');

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
        ws.replyStreamNonBlocking(frame, streamId, hint, false).catch(() => {});
      }
    };

    const textReply = await runAgenticChat(session.history, userInput, session.user, {
      streamEnabled: false,
      logPrefix: `[企微:${instance.botName}:${username}] `,
      showThinking: true,
      agentConfig,
      images,
      onProgress,
      deliveryContext: { channel: 'wework', weworkClient: instance.wsClient, weworkFrame: frame } as DeliveryContext,
    });

    const finalText = textReply || '（无回复内容）';
    await ws.replyStream(frame, streamId, finalText, true);
    return finalText;
  });
}

function handleImageMessageForInstance(instance: WeworkBotInstance, frame: WsFrame<ImageMessage>): Promise<void> {
  return runWithExecutionContext({ channel: 'wework' }, async () => {
    const body = frame.body!;
    const userId = body.from.userid;
    const isGroup = body.chattype === 'group';
    const mapKey = isGroup ? `g:${body.chatid}:${userId}` : userId;
    const username = `wework_${userId.slice(-6)}`;
    const logTag = `[企微:${instance.botName}]`;

    log.dim(`${logTag} ${username}: [图片消息]`);

    try {
      const img = await downloadWeworkImage(instance.wsClient, body.image.url, body.image.aeskey, logTag);
      if (!img) {
        const streamId = generateReqId('stream');
        await instance.wsClient.replyStream(frame, streamId, '图片下载失败，请重试', true);
        return;
      }
      await handleAIChat(instance, frame, '请描述这张图片', mapKey, userId, username, [img]);
    } catch (err: any) {
      log.error(`${logTag} 处理图片消息出错: ${err.message}`);
      const streamId = generateReqId('stream');
      await instance.wsClient.replyStream(frame, streamId, `处理出错: ${err.message}`, true);
    }
  });
}

function handleMixedMessageForInstance(instance: WeworkBotInstance, frame: WsFrame<MixedMessage>): Promise<void> {
  return runWithExecutionContext({ channel: 'wework' }, async () => {
    const body = frame.body!;
    const userId = body.from.userid;
    const isGroup = body.chattype === 'group';
    const mapKey = isGroup ? `g:${body.chatid}:${userId}` : userId;
    const username = `wework_${userId.slice(-6)}`;
    const logTag = `[企微:${instance.botName}]`;

    const textParts: string[] = [];
    const images: ImageInput[] = [];

    for (const item of body.mixed.msg_item) {
      if (item.msgtype === 'text' && item.text?.content) {
        textParts.push(item.text.content.replace(/@\S+\s?/g, '').trim());
      } else if (item.msgtype === 'image' && item.image?.url) {
        const img = await downloadWeworkImage(instance.wsClient, item.image.url, item.image.aeskey, logTag);
        if (img) images.push(img);
      }
    }

    const text = textParts.filter(Boolean).join('\n') || (images.length > 0 ? '请描述这张图片' : '');
    if (!text && images.length === 0) return;

    log.dim(`${logTag} ${username}: [图文混排] text=${text.slice(0, 80)} images=${images.length}`);

    try {
      await handleAIChat(instance, frame, text, mapKey, userId, username, images.length > 0 ? images : undefined);
    } catch (err: any) {
      log.error(`${logTag} 处理图文混排消息出错: ${err.message}`);
      const streamId = generateReqId('stream');
      await instance.wsClient.replyStream(frame, streamId, `处理出错: ${err.message}`, true);
    }
  });
}

function handleFileMessageForInstance(instance: WeworkBotInstance, frame: WsFrame<FileMessage>): Promise<void> {
  return runWithExecutionContext({ channel: 'wework' }, async () => {
    const body = frame.body!;
    const userId = body.from.userid;
    const isGroup = body.chattype === 'group';
    const mapKey = isGroup ? `g:${body.chatid}:${userId}` : userId;
    const username = `wework_${userId.slice(-6)}`;
    const logTag = `[企微:${instance.botName}]`;

    log.dim(`${logTag} ${username}: [文件消息]`);

    try {
      const { buffer, filename: dlFilename } = await instance.wsClient.downloadFile(body.file.url, body.file.aeskey);
      const filename = dlFilename || '未知文件';
      const savedPath = saveUploadedFile(buffer, filename);

      log.dim(`${logTag} 下载文件成功: ${filename} (${buffer.length} bytes) -> ${savedPath}`);

      const text = `用户发送了文件 "${filename}" (${buffer.length} bytes)，已保存到本地路径: ${savedPath}\n请使用合适的工具（parse_word、parse_excel、read_file 等）读取文件内容。`;
      await handleAIChat(instance, frame, text, mapKey, userId, username);
    } catch (err: any) {
      log.error(`${logTag} 处理文件消息出错: ${err.message}`);
      const streamId = generateReqId('stream');
      await instance.wsClient.replyStream(frame, streamId, `文件处理出错: ${err.message}`, true);
    }
  });
}

// --- Slash Commands ---

async function handleSlashCommand(
  instance: WeworkBotInstance,
  text: string,
  mapKey: string,
  userId: string,
  username: string,
): Promise<string | null> {
  const session = getSession(instance.botId, instance.sessions, mapKey, username);
  const agentConfig = getAgent(session.agentName);
  setCurrentAgent(agentConfig);

  return runWithExecutionContext({ channel: 'wework', user: session.user }, async () => {
    if (text === '/start') {
      const role = isAgentAdmin(session.agentName) ? 'agent admin' : 'member';
      return `欢迎使用 Samata！\n\n你的身份：${role}\n\n你可以：\n• 直接输入自然语言提问\n• 使用 /help 查看可用命令\n• 使用 /reset 重置对话上下文`;
    }

    if (text === '/help') {
      const entries = getCommandEntries();
      const lines = ['可用命令：', ''];
      for (const e of entries) {
        lines.push(`${e.name} — ${e.description}`);
        if (e.usage) lines.push(`  用法: ${e.usage}`);
      }
      lines.push('', '也可以直接输入自然语言，AI 助手会帮你处理！');
      return lines.join('\n');
    }

    if (text === '/reset') {
      resetSession(instance.botId, instance.sessions, mapKey);
      return '对话上下文已重置';
    }

    if (text.startsWith('/debug')) {
      return `你的企微用户 ID: ${userId}\nBot: ${instance.botName} (${instance.botId})`;
    }

    if (text.startsWith('/model')) {
      if (!isAgentAdmin(getSession(instance.botId, instance.sessions, mapKey, '').agentName)) {
        return '仅管理员可切换模型';
      }
      const arg = text.replace(/^\/model\s*/, '').trim();
      if (!arg || arg === 'list') {
        const available = getAvailableProviders();
        const current = getProviderName();
        const lines = available.map(p => `${p === current ? '▶ ' : '  '}${p}`);
        return `当前: ${current} / ${getModelName()}\n\n可用 provider:\n${lines.join('\n')}`;
      }
      const ok = switchProvider(arg as ProviderName);
      return ok
        ? `已切换到 ${getProviderName()} / ${getModelName()}`
        : `未知 provider: ${arg}\n可用: ${getAvailableProviders().join(', ')}`;
    }

    const cleaned = text.trim();
    const spaceIdx = cleaned.indexOf(' ');
    const cmd = (spaceIdx > 0 ? cleaned.slice(1, spaceIdx) : cleaned.slice(1)).toLowerCase();
    const args = spaceIdx > 0 ? cleaned.slice(spaceIdx + 1).trim() : '';

    return handleCommand(instance, cmd, args, mapKey);
  });
}

async function handleCommand(instance: WeworkBotInstance, cmd: string, args: string, mapKey: string): Promise<string | null> {
  switch (cmd) {
    case 'status': {
      const data = fetchSystemStatus();
      return formatSystemStatus(data);
    }
    case 'faq': {
      const items = fetchKnowledge(args || undefined);
      return formatKnowledge(items);
    }
    case 'skill': {
      const sub = args.split(/\s+/)[0]?.toLowerCase();
      if (!sub || sub === 'list') {
        const skills = getAllSkills();
        return formatSkillList(skills);
      }
      return null;
    }
    case 'agent':
      return handleAgentCommand(instance, args, mapKey);
    default:
      return null;
  }
}

function handleAgentCommand(instance: WeworkBotInstance, args: string, mapKey: string): string {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();

  if (!sub) {
    const session = getSession(instance.botId, instance.sessions, mapKey, '');
    const agent = getAgent(session.agentName);
    return `当前 Agent: ${agent.displayName} (${agent.name})\n${agent.description || ''}`;
  }

  return '`/agent` 的 list/switch 等管理操作仅支持 CLI channel';
}

// --- Welcome event ---

async function handleEnterChat(instance: WeworkBotInstance, frame: WsFrame<EventMessageWith<EnterChatEvent>>): Promise<void> {
  try {
    const agentConfig = resolveAgent('wework', instance.botId) ?? getDefaultAgent();
    const welcomeText = `你好！我是${agentConfig.displayName}，有什么可以帮你的？`;

    await instance.wsClient.replyWelcome(frame, {
      msgtype: 'text',
      text: { content: welcomeText },
    });
  } catch (err: any) {
    log.error(`[企微:${instance.botName}] 发送欢迎语失败: ${err.message}`);
  }
}

// --- Lifecycle ---

export async function startWeworkBot(botId: string, botName?: string): Promise<void> {
  if (botInstances.has(botId)) {
    log.warn(`[企微:${botId}] Bot 已在运行中`);
    return;
  }

  const row = getDb().prepare("SELECT * FROM bot_apps WHERE id = ? AND channel = 'wework'").get(botId) as BotAppRow | undefined;
  if (!row) {
    log.warn(`[企微] 未找到 bot 配置: ${botId}`);
    return;
  }

  const ws = createWsClient(row.id, row.secret);
  const name = botName || row.name;

  const instance: WeworkBotInstance = {
    botId: row.id,
    botName: name,
    wsClient: ws,
    sessions: new Map(),
    cleanupTimer: null,
  };

  ws.on('authenticated', () => log.success(`[企微:${name}] WebSocket 认证成功`));
  ws.on('disconnected', (reason) => log.warn(`[企微:${name}] WebSocket 断开: ${reason}`));
  ws.on('reconnecting', (attempt) => log.info(`[企微:${name}] 正在重连 (第 ${attempt} 次)...`));
  ws.on('error', (err) => log.error(`[企微:${name}] WebSocket 错误: ${err.message}`));

  ws.on('message.text', (frame) => handleTextMessageForInstance(instance, frame).catch(err =>
    log.error(`[企微:${name}] 处理文本消息出错: ${err.message}`)
  ));
  ws.on('message.image', (frame) => handleImageMessageForInstance(instance, frame).catch(err =>
    log.error(`[企微:${name}] 处理图片消息出错: ${err.message}`)
  ));
  ws.on('message.mixed', (frame) => handleMixedMessageForInstance(instance, frame).catch(err =>
    log.error(`[企微:${name}] 处理图文混排消息出错: ${err.message}`)
  ));
  ws.on('message.file', (frame) => handleFileMessageForInstance(instance, frame).catch(err =>
    log.error(`[企微:${name}] 处理文件消息出错: ${err.message}`)
  ));

  ws.on('event.enter_chat', (frame) => handleEnterChat(instance, frame));

  ws.connect();

  instance.cleanupTimer = setInterval(() => {
    const cleaned = cleanupSessions(instance.sessions);
    if (cleaned > 0) log.dim(`[企微:${name}] 清理过期会话: ${cleaned} 个`);
  }, 30 * 60 * 1000);

  botInstances.set(botId, instance);
  log.success(`[企微:${name}] Bot 已启动（WebSocket 长连接模式）`);
}

export function stopWeworkBot(botId: string): void {
  const instance = botInstances.get(botId);
  if (!instance) return;
  instance.wsClient.disconnect();
  if (instance.cleanupTimer) clearInterval(instance.cleanupTimer);
  botInstances.delete(botId);
  log.info(`[企微:${instance.botName}] Bot 已停止`);
}

export async function startAllWeworkBots(): Promise<void> {
  const apps = getBotAppsByChannel('wework', true);
  if (apps.length === 0) {
    log.dim('[企微] 未配置需自动启动的 Bot，跳过启动');
    return;
  }
  for (const app of apps) {
    await startWeworkBot(app.id, app.name);
  }
}

export function stopAllWeworkBots(): void {
  for (const botId of [...botInstances.keys()]) {
    stopWeworkBot(botId);
  }
}

export function isWeworkBotRunning(botId?: string): boolean {
  if (botId) {
    const inst = botInstances.get(botId);
    return inst ? (inst.wsClient as any).isConnected ?? true : false;
  }
  return botInstances.size > 0;
}

export function getFirstConnectedWsClient(): WSClient | null {
  for (const inst of botInstances.values()) {
    if (inst.wsClient.isConnected) return inst.wsClient;
  }
  return null;
}

export function syncWeworkBots(): void {
  const dbApps = getDb().prepare("SELECT id, auto_start FROM bot_apps WHERE channel = 'wework'").all() as { id: string; auto_start: number }[];

  for (const row of dbApps) {
    const isRunning = botInstances.has(row.id);
    const shouldRun = row.auto_start === 1;

    if (shouldRun && !isRunning) {
      log.info(`[企微] 检测到新配置，正在启动 Bot: ${row.id}`);
      startWeworkBot(row.id);
    } else if (!shouldRun && isRunning) {
      log.info(`[企微] 配置已关闭，正在停止 Bot: ${row.id}`);
      stopWeworkBot(row.id);
    }
  }
}
