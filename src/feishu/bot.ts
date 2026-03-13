/**
 * 飞书 Bot
 *
 * 支持两种交互模式：
 * 1. /command — 直接调用命令函数，格式化后返回（不经过 LLM）
 * 2. 自然语言 — 由 AI Agent 处理
 *
 * 连接模式：
 * - ws（默认）：WebSocket 长连接，通过 @larksuiteoapi/node-sdk WSClient 接收事件
 * - webhook：HTTP 回调，需要公网可达地址
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuAPI, type FeishuConfig, type FeishuMessage } from './api.js';
import { buildCard, buildThinkingCard } from './card.js';
import { getSession, resetSession, setAdminIds, cleanupSessions, isAdminFeishuUser } from './session.js';
import { getProvider, getModelName, switchProvider, getProviderName, getAvailableProviders, type ProviderName } from '../llm/provider.js';
import { setCurrentUser, getCurrentUser } from '../auth/rbac.js';
import { runAgenticChat, type ImageInput, detectImageMediaType } from '../llm/agent.js';
import { getAgent, getAllAgents } from '../llm/agents/config.js';
import { log } from '../utils/logger.js';
import { fetchClients, fetchClient, fetchHistory, addClient, advanceClient } from '../commands/client.js';
import { fetchSystemStatus, formatSystemStatus } from '../commands/monitor.js';
import { fetchTrades } from '../commands/trade.js';
import { fetchKnowledge } from '../commands/knowledge.js';
import { getAllSkills } from '../commands/skill.js';
import {
  formatClientList, formatClientDetail,
  formatClientHistory, formatTrades, formatKnowledge, formatSkillList,
  formatSuccess, formatError,
} from './formatter.js';

interface FeishuBotConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
}

function loadFeishuConfig(): FeishuBotConfig {
  const file = resolve(process.cwd(), 'config/monitor.json');
  const config = JSON.parse(readFileSync(file, 'utf-8'));
  return config.feishu as FeishuBotConfig;
}

export type FeishuBotMode = 'ws' | 'webhook';

let api: FeishuAPI;
let wsClient: InstanceType<typeof Lark.WSClient> | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;
let running = false;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let botOpenId = '';  // 机器人自身的 open_id，用于群聊 @mention 检测

/**
 * 处理 AI 对话（含 tool use 循环）
 */
async function handleAIChat(
  chatId: string,
  userInput: string,
  feishuUserId: string,
  feishuUsername: string,
  images?: ImageInput[],
  replyOpts?: { messageId?: string; isGroup?: boolean },
): Promise<{ text: string; placeholderMsgId?: string }> {
  const session = getSession(feishuUserId, feishuUsername);

  // 立即发送占位卡片，让用户知道正在处理
  let placeholderMsgId: string | undefined;
  try {
    const thinkingCard = buildThinkingCard('🤔 思考中...');
    if (replyOpts?.isGroup && replyOpts?.messageId) {
      placeholderMsgId = await api.replyMessage(replyOpts.messageId, 'interactive', JSON.stringify(thinkingCard));
    } else {
      placeholderMsgId = await api.sendCard(chatId, thinkingCard);
    }
  } catch (err: any) {
    log.warn(`[飞书] 发送占位卡片失败: ${err.message}`);
  }

  // 临时切换当前用户上下文（tool handler 依赖），处理完后恢复
  const prevUser = getCurrentUser();
  setCurrentUser(session.user);

  try {
    // 解析当前 session 使用的 Agent
    const agentConfig = getAgent(session.agentName);

    // 渐进更新占位卡片（节流 1.5s）
    let lastUpdateTime = 0;
    const THROTTLE_MS = 1500;
    const onProgress = placeholderMsgId
      ? (event: import('../llm/agent.js').ProgressEvent) => {
          const now = Date.now();
          if (now - lastUpdateTime < THROTTLE_MS) return;
          lastUpdateTime = now;
          let hint = '';
          if (event.type === 'tool_start') hint = `🔧 正在调用 ${event.name}...`;
          else if (event.type === 'tool_end') hint = `✅ ${event.name} 完成，继续思考...`;
          else if (event.type === 'thinking') hint = `💭 ${event.text.slice(0, 80)}`;
          if (hint) {
            api.updateCard(placeholderMsgId!, buildThinkingCard(hint)).catch(() => {});
          }
        }
      : undefined;

    const textReply = await runAgenticChat(session.history, userInput, session.user, {
      streamEnabled: false,
      logPrefix: `[飞书:${feishuUsername}] `,
      showThinking: true,
      agentConfig,
      images,
      onProgress,
    });

    return { text: textReply || '（无回复内容）', placeholderMsgId };
  } finally {
    setCurrentUser(prevUser);
  }
}

/**
 * 将回复以飞书消息卡片发送，失败时回退到纯文本
 * 群聊消息使用 reply（回复原消息）方式发送
 * 如果提供 updateMessageId，则更新已有卡片而非发新消息
 */
async function sendFeishuReply(
  chatId: string,
  text: string,
  options?: { messageId?: string; isGroup?: boolean; updateMessageId?: string }
): Promise<string> {
  // 更新已有卡片模式
  if (options?.updateMessageId) {
    try {
      const card = buildCard(text);
      await api.updateCard(options.updateMessageId, card);
      return options.updateMessageId;
    } catch (err: any) {
      log.warn(`[飞书] 更新卡片失败，回退到发新消息: ${err.message}`);
      // fallthrough 到下面的发新消息逻辑
    }
  }

  const useReply = options?.isGroup && options?.messageId;

  if (!text || text === '（无回复内容）') {
    if (useReply) {
      return api.replyMessage(options.messageId!, 'text', { text: text || '（无回复内容）' });
    } else {
      return api.sendText(chatId, text || '（无回复内容）');
    }
  }
  try {
    const card = buildCard(text);
    if (useReply) {
      return api.replyMessage(options.messageId!, 'interactive', JSON.stringify(card));
    } else {
      return api.sendCard(chatId, card);
    }
  } catch (err: any) {
    log.warn(`[飞书] Card 构建失败，回退到纯文本: ${err.message}`);
    if (useReply) {
      return api.replyMessage(options.messageId!, 'text', { text });
    } else {
      return api.sendText(chatId, text);
    }
  }
}

/**
 * 直接处理 /command，不经过 LLM
 * 返回格式化后的文本，或 null 表示未匹配到命令
 */
async function handleCommand(cmd: string, args: string, feishuUserId: string): Promise<string | null> {
  switch (cmd) {
    case 'status': {
      const data = fetchSystemStatus();
      return formatSystemStatus(data);
    }
    case 'client': {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || '').toLowerCase();
      const rest = parts.slice(1).join(' ');
      return handleClientSubcommand(sub, rest, feishuUserId);
    }
    // keep old top-level aliases working
    case 'list':    return handleClientSubcommand('list', args, feishuUserId);
    case 'view':    return handleClientSubcommand('view', args, feishuUserId);
    case 'history': return handleClientSubcommand('history', args, feishuUserId);
    case 'add':     return handleClientSubcommand('add', args, feishuUserId);
    case 'advance': return handleClientSubcommand('advance', args, feishuUserId);
    case 'trade': {
      const params: Record<string, string> = {};
      for (const m of args.matchAll(/(\w+)=(\S+)/g)) {
        params[m[1].toLowerCase()] = m[2];
      }
      try {
        const trades = await fetchTrades({
          client: params.client,
          party: params.party,
          user: params.user,
          date: params.date,
          limit: params.limit ? Number(params.limit) : undefined,
        });
        return formatTrades(trades);
      } catch (err: any) {
        return formatError(err.message);
      }
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
      return null; // skill save/run/del 需要更复杂的处理，走 AI
    }
    case 'agent': {
      return handleAgentCommand(args, feishuUserId);
    }
    default:
      return null; // 未匹配的命令
  }
}

async function handleClientSubcommand(sub: string, rest: string, feishuUserId: string): Promise<string | null> {
  switch (sub) {
    case 'list': case '': {
      const filter: { state?: string; keyword?: string } = {};
      const stateMatch = rest.match(/state=(\S+)/);
      if (stateMatch) filter.state = stateMatch[1];
      const remaining = rest.replace(/state=\S+/, '').trim();
      if (remaining) filter.keyword = remaining;
      const clients = fetchClients(Object.keys(filter).length > 0 ? filter : undefined);
      return await formatClientList(clients);
    }
    case 'view': {
      if (!rest) return formatError('用法: /client view <客户名称或ID>');
      const client = fetchClient(rest);
      if (!client) return formatError(`未找到客户: ${rest}`);
      return formatClientDetail(client);
    }
    case 'history': {
      if (!rest) return formatError('用法: /client history <客户名称或ID>');
      const result = fetchHistory(rest);
      if (!result) return formatError(`未找到客户: ${rest}`);
      return formatClientHistory(result.name, result.events);
    }
    case 'add': {
      if (!isAdminFeishuUser(feishuUserId)) return formatError('权限不足：该命令需要管理员权限');
      if (!rest) return formatError('用法: /client add <名称> [contact=xx] [wework_group=xx] [sales=xx]');
      const prevUser = getCurrentUser();
      const session = getSession(feishuUserId, '');
      setCurrentUser(session.user);
      try {
        const result = addClient(rest);
        if (result.success) return formatSuccess(`客户已添加: ${result.name} (${result.id})`);
        return formatError(result.error);
      } finally {
        setCurrentUser(prevUser);
      }
    }
    case 'advance': {
      if (!isAdminFeishuUser(feishuUserId)) return formatError('权限不足：该命令需要管理员权限');
      if (!rest) return formatError('用法: /client advance <客户名称或ID>');
      const prevUser = getCurrentUser();
      const session = getSession(feishuUserId, '');
      setCurrentUser(session.user);
      try {
        const result = advanceClient(rest);
        if (result.success) return formatSuccess(`${result.name}: ${result.from} → ${result.to}`);
        return formatError(result.error);
      } finally {
        setCurrentUser(prevUser);
      }
    }
    default:
      return formatError('用法: /client <list|view|history|add|advance> [参数]');
  }
}

function handleAgentCommand(args: string, feishuUserId: string): string {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();

  // /agent — show current agent
  if (!sub) {
    const session = getSession(feishuUserId, '');
    const agent = getAgent(session.agentName);
    return `当前 Agent: ${agent.displayName} (${agent.name})\n${agent.description || ''}`;
  }

  // /agent list — list all agents
  if (sub === 'list') {
    const agents = getAllAgents();
    const session = getSession(feishuUserId, '');
    const lines = agents.map(a => {
      const marker = a.name === session.agentName ? '▶ ' : '  ';
      return `${marker}${a.name} — ${a.displayName}${a.description ? ` (${a.description})` : ''}`;
    });
    return `可用 Agent:\n${lines.join('\n')}`;
  }

  // /agent <name> — switch agent
  const agent = getAgent(sub);
  if (agent.name !== sub && sub !== 'otcclaw') {
    return `❌ 未找到 Agent: ${sub}\n使用 /agent list 查看所有可用 Agent`;
  }

  const session = getSession(feishuUserId, '');
  session.agentName = agent.name;
  session.history = [];
  return `✅ 已切换到 Agent: ${agent.displayName} (${agent.name})${agent.description ? `\n${agent.description}` : ''}`;
}

/**
 * 处理飞书消息事件（FeishuMessage 已统一为 v2 结构）
 */
async function handleEvent(event: FeishuMessage): Promise<void> {
  const chatId = event.message.chat_id;
  const chatType = event.message.chat_type;  // "p2p" | "group"
  const messageType = event.message.message_type;
  const messageId = event.message.message_id;
  const isGroup = chatType === 'group';

  log.info(`[飞书] 收到消息: chat_id=${chatId}, chat_type=${chatType}, type=${messageType}`);

  // 群聊：只响应 @bot 的消息
  if (isGroup) {
    const mentions = event.message.mentions || [];
    const mentionedBot = botOpenId
      ? mentions.some(m => m.id.open_id === botOpenId)
      : mentions.length > 0;  // 未获取到 botOpenId 时，有 @mention 就响应
    if (!mentionedBot) {
      log.dim(`[飞书] 群聊消息未 @bot，忽略: ${chatId}`);
      return;
    }
  }

  // 解析消息内容
  // WSClient 可能传入已解析的对象，Webhook 传入 JSON 字符串，统一处理
  let text = '';
  let images: ImageInput[] | undefined;
  try {
    const raw = event.message.content;
    const content = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (messageType === 'text') {
      text = content.text || '';
    } else if (messageType === 'post') {
      // post 类型的 content 结构：{ title, content: [[{ tag, text/image_key, ... }]] }
      // 富文本中可能混合文字和图片（tag: "text" / "img" / "a" 等）
      const postBody = content.zh_cn || content.en_us || content;
      const title = postBody.title || '';
      const lines: string[] = [];
      const imageKeys: string[] = [];
      if (Array.isArray(postBody.content)) {
        for (const line of postBody.content) {
          if (Array.isArray(line)) {
            const textParts: string[] = [];
            for (const seg of line as any[]) {
              if (seg.tag === 'img' && seg.image_key) {
                imageKeys.push(seg.image_key);
              } else if (seg.text) {
                textParts.push(seg.text);
              }
            }
            if (textParts.length > 0) lines.push(textParts.join(''));
          }
        }
      }
      text = [title, ...lines].filter(Boolean).join('\n');

      // 下载 post 中的图片
      if (imageKeys.length > 0) {
        images = [];
        for (const key of imageKeys) {
          try {
            const buf = await api.downloadMessageResource(messageId, key);
            images.push({ data: buf.toString('base64'), mediaType: detectImageMediaType(buf) });
            log.dim(`[飞书] 下载 post 图片成功: ${key} (${buf.length} bytes)`);
          } catch (err: any) {
            log.error(`[飞书] 下载 post 图片失败: ${key} - ${err.message}`);
          }
        }
        if (images.length === 0) images = undefined;
        if (!text && images) text = '请描述这张图片';
      }
    } else if (messageType === 'image') {
      // image 类型的 content 结构：{ image_key: "img_xxx" }
      const imageKey = content.image_key;
      if (imageKey) {
        try {
          const buf = await api.downloadMessageResource(messageId, imageKey);
          images = [{
            data: buf.toString('base64'),
            mediaType: detectImageMediaType(buf),
          }];
          text = '请描述这张图片';
          log.dim(`[飞书] 下载图片成功: ${imageKey} (${buf.length} bytes)`);
        } catch (err: any) {
          log.error(`[飞书] 下载图片失败: ${err.message}`);
          text = '';
        }
      }
    } else {
      // file / audio 等暂不支持，提示用户
      text = '';
    }
  } catch {
    text = event.message.content || '';
  }

  // 群聊：从文本中去掉 @mention 占位符（如 @_user_1）
  if (isGroup && event.message.mentions?.length) {
    for (const m of event.message.mentions) {
      if (m.key) {
        text = text.replace(m.key, '');
      }
    }
    text = text.trim();
  }

  // 获取发送者信息
  const senderId = event.sender.sender_id.open_id || event.sender.sender_id.user_id || '';
  const senderName = `user_${senderId.slice(-6)}`;

  log.dim(`[飞书] 解析结果: text="${text.slice(0, 50)}", senderId=${senderId}, group=${isGroup}`);

  // 群聊回复选项：群里以 reply 方式回复原消息
  const replyOpts = isGroup ? { messageId, isGroup: true } : undefined;

  // /debug 命令：显示用户飞书 ID（简化版，直接返回 senderId，不依赖 getUser API）
  if (text.startsWith('/debug')) {
    try {
      await sendFeishuReply(chatId, `你的飞书用户 ID: ${senderId}`, replyOpts);
    } catch (err: any) {
      log.error(`[飞书] /debug 发送失败: ${err.message}`);
    }
    return;
  }

  if (!text) {
    log.dim(`[飞书] 忽略空消息或不支持的类型: ${messageType}`);
    return;
  }

  log.dim(`[飞书] ${senderName}: ${text.slice(0, 80)}`);

  try {
    // 处理内置命令
    if (text === '/start') {
      const role = isAdminFeishuUser(senderId) ? '管理员' : '普通用户';
      await sendFeishuReply(chatId,
        `👋 欢迎使用 OTC Claw！\n\n` +
        `你的身份：${role}\n\n` +
        `你可以：\n` +
        `• 直接输入自然语言提问\n` +
        `• 使用 /help 查看可用命令\n` +
        `• 使用 /reset 重置对话上下文`,
        replyOpts
      );
      return;
    }

    if (text === '/help') {
      await sendFeishuReply(chatId,
        `📋 *衍语 Bot 命令*\n\n` +
        `*基础命令：*\n` +
        `/start - 开始使用\n` +
        `/help - 查看帮助\n` +
        `/reset - 重置对话上下文\n` +
        `/status - 系统状态\n\n` +
        `*客户管理：*\n` +
        `/client list [state=xx] - 客户列表\n` +
        `/client view <名称> - 查看客户详情\n` +
        `/client history <名称> - 操作历史\n` +
        `/client add <名称> - 添加客户 👑\n` +
        `/client advance <名称> - 推进状态 👑\n\n` +
        `*查询命令：*\n` +
        `/trade <参数> - 交易查询\n` +
        `/faq <关键词> - 搜索知识库\n\n` +
        `*Agent 管理：*\n` +
        `/agent - 查看当前 Agent\n` +
        `/agent list - 列出所有 Agent\n` +
        `/agent <name> - 切换 Agent\n\n` +
        `💡 也可以直接输入自然语言，AI 助手会帮你处理！`,
        replyOpts
      );
      return;
    }

    if (text === '/reset') {
      resetSession(senderId);
      await sendFeishuReply(chatId, '✅ 对话上下文已重置', replyOpts);
      return;
    }

    // /model 命令：查看或切换 LLM provider
    if (text.startsWith('/model')) {
      if (!isAdminFeishuUser(senderId)) {
        await sendFeishuReply(chatId, '❌ 仅管理员可切换模型', replyOpts);
        return;
      }
      const arg = text.replace(/^\/model\s*/, '').trim();
      if (!arg || arg === 'list') {
        const available = getAvailableProviders();
        const current = getProviderName();
        const lines = available.map(p => `${p === current ? '▶ ' : '  '}${p}`);
        await sendFeishuReply(chatId, `当前: ${current} / ${getModelName()}\n\n可用 provider:\n${lines.join('\n')}`, replyOpts);
      } else {
        const ok = switchProvider(arg as ProviderName);
        if (ok) {
          await sendFeishuReply(chatId, `✅ 已切换到 ${getProviderName()} / ${getModelName()}`, replyOpts);
        } else {
          await sendFeishuReply(chatId, `❌ 未知 provider: ${arg}\n可用: ${getAvailableProviders().join(', ')}`, replyOpts);
        }
      }
      return;
    }

    // /command 格式 → 直接调用命令函数，不经过 LLM
    if (text.startsWith('/')) {
      const cleaned = text.trim();
      const spaceIdx = cleaned.indexOf(' ');
      const cmd = (spaceIdx > 0 ? cleaned.slice(1, spaceIdx) : cleaned.slice(1)).toLowerCase();
      const args = spaceIdx > 0 ? cleaned.slice(spaceIdx + 1).trim() : '';

      const reply = await handleCommand(cmd, args, senderId);
      if (reply !== null) {
        await sendFeishuReply(chatId, reply, replyOpts);
        return;
      }
      // 未匹配的命令，fallthrough 到 AI Agent
    }

    // 自然语言 → AI Agent
    const { text: reply, placeholderMsgId } = await handleAIChat(chatId, text, senderId, senderName, images, replyOpts);
    await sendFeishuReply(chatId, reply, { ...replyOpts, updateMessageId: placeholderMsgId });

  } catch (err: any) {
    const cause = err.cause ? ` | cause: ${err.cause.message || err.cause.code || err.cause}` : '';
    log.error(`[飞书] 处理消息出错: ${err.message}${cause}`);
    try {
      await sendFeishuReply(chatId, `❌ 处理出错: ${err.message}`, replyOpts);
    } catch { /* ignore send error */ }
  }
}

/**
 * 验证飞书回调签名
 */
function verifySignature(timestamp: string, nonce: string, signature: string, body: string): boolean {
  const config = loadFeishuConfig();
  if (!config.appSecret) {
    log.warn('[飞书] 未配置 appSecret，跳过签名验证');
    return true;
  }

  const signString = `${timestamp}${nonce}${body}`;
  const hmac = crypto.createHmac('sha256', config.appSecret);
  hmac.update(signString);
  const computedSignature = hmac.digest('base64');

  return computedSignature === signature;
}

/**
 * 处理 HTTP Webhook 请求
 * 导出供 Express/Http 服务器调用
 * 兼容飞书 Event API v1 和 v2
 */
export async function handleWebhookRequest(
  headers: Record<string, string | string[] | undefined>,
  body: any
): Promise<{ status: number; body: any }> {
  log.info(`[飞书 HTTP] 收到请求: schema=${body?.schema || 'v1'}, type=${body?.type || body?.header?.event_type || '-'}`);

  // 处理验证挑战（飞书机器人配置时的 URL 验证，v1/v2 通用）
  if (body.type === 'url_verification') {
    return {
      status: 200,
      body: { challenge: body.challenge },
    };
  }

  // ── Event API v2 ──
  if (body.schema === '2.0' && body.header && body.event) {
    const eventType = body.header.event_type as string;
    if (eventType === 'im.message.receive_v1') {
      const event = body.event as FeishuMessage;
      handleEvent(event).catch(err => {
        log.error(`[飞书] 处理事件出错: ${err.message}`);
      });
    } else {
      log.dim(`[飞书] 忽略事件类型: ${eventType}`);
    }
    return { status: 200, body: { code: 0 } };
  }

  // ── Event API v1 (legacy) ──
  if (body.type === 'event_callback' && body.event) {
    const v1 = body.event;
    if (v1.type === 'message') {
      // 将 v1 扁平结构转换为 v2 FeishuMessage 格式
      const isGroupV1 = v1.chat_type !== 'private';
      const contentStr =
        v1.msg_type === 'text'
          ? JSON.stringify({ text: v1.text_without_at_bot || v1.text || '' })
          : (v1.text || '');
      // v1 群聊消息如果有 text_without_at_bot，说明 bot 被 @了，构造 mentions
      const mentions: FeishuMessage['message']['mentions'] =
        isGroupV1 && v1.text_without_at_bot && botOpenId
          ? [{ key: '', id: { open_id: botOpenId }, name: 'bot' }]
          : undefined;
      const event: FeishuMessage = {
        sender: {
          sender_id: {
            open_id: v1.open_id,
            user_id: v1.user_id || v1.employee_id,
          },
          sender_type: 'user',
        },
        message: {
          message_id: v1.open_message_id || '',
          root_id: v1.root_id,
          parent_id: v1.parent_id,
          create_time: v1.create_time || '',
          chat_id: v1.open_chat_id,
          chat_type: v1.chat_type === 'private' ? 'p2p' : 'group',
          message_type: v1.msg_type || 'text',
          content: contentStr,
          mentions,
        },
      };
      handleEvent(event).catch(err => {
        log.error(`[飞书] 处理事件出错: ${err.message}`);
      });
    }
    return { status: 200, body: { code: 0 } };
  }

  return { status: 200, body: { code: 0 } };
}

/**
 * 启动 WebSocket 长连接（通过 SDK WSClient 接收事件）
 */
function startWSClient(config: { appId: string; appSecret: string }): void {
  const eventDispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.error }).register({
    'im.message.receive_v1': async (data: any) => {
      const event = data as FeishuMessage;
      handleEvent(event).catch(err => {
        log.error(`[飞书 WS] 处理事件出错: ${err.message}`);
      });
    },
    'im.message.message_read_v1': async () => {
      // 已读回执，无需处理
    },
  });

  wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher });
  log.info('[飞书] WebSocket 长连接已启动');
}

/**
 * 启动飞书 Bot
 * @param options.mode 连接模式: 'ws'(长连接,默认) | 'webhook'(HTTP回调)
 * @param options.httpPort webhook 模式的 HTTP 端口
 * @param options.httpPath webhook 模式的路径（默认 /webhook/feishu）
 */
export async function startFeishuBot(options?: {
  mode?: FeishuBotMode;
  httpPort?: number;
  httpPath?: string;
}): Promise<void> {
  if (running) {
    log.warn('[飞书] Bot 已在运行中');
    log.print('[飞书] Bot 已在运行中');
    return;
  }

  // 清除代理环境变量（可选，防止飞书 API 误走本地代理）
  // delete process.env.HTTP_PROXY;
  // delete process.env.HTTPS_PROXY;
  // delete process.env.http_proxy;
  // delete process.env.https_proxy;

  const feishuConfig = loadFeishuConfig();

  if (!feishuConfig.appId || !feishuConfig.appSecret) {
    log.error('[飞书] 未配置 appId/appSecret，请在 config/monitor.json 中设置 feishu.appId 和 feishu.appSecret');
    log.print('[飞书] 未配置 appId/appSecret，请在 config/monitor.json 中设置 feishu.appId 和 feishu.appSecret');
    return;
  }

  // 解析管理员飞书用户 ID 列表
  const adminIdsStr = process.env.FEISHU_ADMIN_IDS || '';
  const adminIdList = adminIdsStr.split(',').map(s => s.trim()).filter(s => s);
  setAdminIds(adminIdList);

  if (adminIdList.length === 0) {
    log.warn('[飞书] 未配置 FEISHU_ADMIN_IDS，所有用户将以只读身份使用');
  } else {
    log.info(`[飞书] 管理员飞书 IDs: ${adminIdList.join(', ')}`);
  }

  // 初始化飞书 API
  api = new FeishuAPI(feishuConfig);

  // 验证配置
  try {
    await api.getTenantAccessToken();
    log.success('[飞书] API 连接成功');
    log.print('[飞书] API 连接成功');
  } catch (err: any) {
    log.error(`[飞书] API 连接失败: ${err.message}`);
    log.print(`[飞书] API 连接失败: ${err.message}`);
    return;
  }

  // 获取机器人自身 open_id，用于群聊 @mention 检测
  try {
    const botInfo = await api.getBotInfo();
    botOpenId = botInfo.open_id;
    log.info(`[飞书] 机器人 open_id: ${botOpenId} (${botInfo.app_name})`);
  } catch (err: any) {
    log.warn(`[飞书] 获取机器人信息失败，群聊 @mention 检测将使用宽松模式: ${err.message}`);
  }

  // 定时清理过期会话（每 30 分钟）
  cleanupTimer = setInterval(() => {
    const cleaned = cleanupSessions();
    if (cleaned > 0) log.dim(`[飞书] 清理了 ${cleaned} 个过期会话`);
  }, 30 * 60 * 1000);

  running = true;

  const mode: FeishuBotMode = options?.mode
    || (process.env.FEISHU_MODE as FeishuBotMode)
    || 'ws';

  if (mode === 'ws') {
    // ── 长连接模式：通过 SDK WSClient 接收事件 ──
    startWSClient({ appId: feishuConfig.appId, appSecret: feishuConfig.appSecret });
  } else {
    // ── Webhook 模式：HTTP 服务器接收回调 ──
    const httpPort = options?.httpPort;
    if (httpPort) {
      const webhookPath = options?.httpPath || '/webhook/feishu';
      const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Feishu-Signature, X-Feishu-Timestamp, X-Feishu-Nonce');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        if (req.method === 'POST' && req.url === webhookPath) {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
          }

          try {
            const jsonBody = JSON.parse(body);
            const headers = req.headers as Record<string, string | string[] | undefined>;
            const result = await handleWebhookRequest(headers, jsonBody);

            res.writeHead(result.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.body));
          } catch (err: any) {
            log.error(`[飞书 HTTP] 处理请求出错: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // 健康检查
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      });

      server.listen(httpPort, () => {
        log.success(`[飞书] HTTP 服务已启动: http://localhost:${httpPort}${webhookPath}`);
      });
      httpServer = server;
    }
  }

  log.success(`[飞书] Bot 已启动 (模式: ${mode})`);
  log.print(`[飞书] Bot 已启动 (模式: ${mode})`);
}

/**
 * 停止飞书 Bot
 */
export function stopFeishuBot(): void {
  if (!running) {
    log.warn('[飞书] Bot 未在运行');
    log.print('[飞书] Bot 未在运行');
    return;
  }
  running = false;
  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  log.success('[飞书] Bot 已停止');
  log.print('[飞书] Bot 已停止');
}

/**
 * 查询 Bot 是否运行中
 */
export function isFeishuBotRunning(): boolean {
  return running;
}
