/**
 * 飞书 Bot
 *
 * 支持两种交互模式（Webhook 方式）：
 * 1. /command — 直接调用命令函数，格式化后返回（不经过 LLM）
 * 2. 自然语言 — 由 AI Agent 处理
 *
 * 架构：Webhook 接收 + 每用户独立会话 + 命令直通 + 自然语言走 agent
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { FeishuAPI, type FeishuConfig, type FeishuMessage } from './api.js';
import { getSession, resetSession, setAdminIds, cleanupSessions, isAdminFeishuUser } from './session.js';
import { getProvider, getModelName, switchProvider, getProviderName, getAvailableProviders, type ProviderName } from '../llm/provider.js';
import { setCurrentUser } from '../auth/rbac.js';
import { getTools, executeTool, getSystemPrompt } from '../llm/agent.js';
import { log } from '../utils/logger.js';
import { fetchClients, fetchClient, fetchHistory, addClient, advanceClient } from '../commands/client.js';
import { fetchStatus } from '../commands/monitor.js';
import { fetchTrades } from '../commands/trade.js';
import { fetchKnowledge } from '../commands/knowledge.js';
import { getAllSkills } from '../commands/skill.js';
import {
  formatStatusSummary, formatClientList, formatClientDetail,
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

const MAX_HISTORY = 40; // 每个会话最多保留的消息对数

let api: FeishuAPI;
let running = false;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 处理 AI 对话（含 tool use 循环）
 */
async function handleAIChat(
  chatId: string,
  userInput: string,
  feishuUserId: string,
  feishuUsername: string
): Promise<string> {
  const session = getSession(feishuUserId, feishuUsername);
  const provider = getProvider();

  // 临时切换当前用户上下文（tool handler 依赖）
  setCurrentUser(session.user);

  session.history.push({ role: 'user', content: userInput });

  // 控制历史长度
  while (session.history.length > MAX_HISTORY * 2) {
    session.history.shift();
  }

  const tools = getTools();
  const systemPrompt = getSystemPrompt(session.user);

  let response = await provider.createMessage({
    model: getModelName(),
    max_tokens: 4096,
    system: systemPrompt,
    tools,
    messages: session.history,
  });

  // Agentic loop
  while (response.stop_reason === 'tool_use') {
    const assistantContent = response.content;
    session.history.push({ role: 'assistant', content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        log.dim(`[飞书:${feishuUsername}] 🔧 ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`);
        const result = await executeTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    session.history.push({ role: 'user', content: toolResults });

    response = await provider.createMessage({
      model: getModelName(),
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages: session.history,
    });
  }

  // 提取文本回复
  const assistantContent = response.content;
  session.history.push({ role: 'assistant', content: assistantContent });

  const texts: string[] = [];
  for (const block of assistantContent) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text);
    }
  }

  return texts.join('\n\n') || '（无回复内容）';
}

/**
 * 直接处理 /command，不经过 LLM
 * 返回格式化后的文本，或 null 表示未匹配到命令
 */
async function handleCommand(cmd: string, args: string, feishuUserId: string): Promise<string | null> {
  switch (cmd) {
    case 'status': {
      const data = fetchStatus();
      return formatStatusSummary(data);
    }
    case 'list': {
      const filter: { state?: string; keyword?: string } = {};
      const stateMatch = args.match(/state=(\S+)/);
      if (stateMatch) filter.state = stateMatch[1];
      const remaining = args.replace(/state=\S+/, '').trim();
      if (remaining) filter.keyword = remaining;
      const clients = fetchClients(Object.keys(filter).length > 0 ? filter : undefined);
      return formatClientList(clients);
    }
    case 'view': {
      if (!args) return formatError('用法: /view <客户名称或ID>');
      const client = fetchClient(args);
      if (!client) return formatError(`未找到客户: ${args}`);
      return formatClientDetail(client);
    }
    case 'history': {
      if (!args) return formatError('用法: /history <客户名称或ID>');
      const result = fetchHistory(args);
      if (!result) return formatError(`未找到客户: ${args}`);
      return formatClientHistory(result.name, result.events);
    }
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
    case 'add': {
      if (!isAdminFeishuUser(feishuUserId)) return formatError('权限不足：该命令需要管理员权限');
      if (!args) return formatError('用法: /add <名称> [contact=xx] [wework_group=xx] [sales=xx]');
      const session = getSession(feishuUserId, '');
      setCurrentUser(session.user);
      const result = addClient(args);
      if (result.success) return formatSuccess(`客户已添加: ${result.name} (${result.id})`);
      return formatError(result.error);
    }
    case 'advance': {
      if (!isAdminFeishuUser(feishuUserId)) return formatError('权限不足：该命令需要管理员权限');
      if (!args) return formatError('用法: /advance <客户名称或ID>');
      const session = getSession(feishuUserId, '');
      setCurrentUser(session.user);
      const result = advanceClient(args);
      if (result.success) return formatSuccess(`${result.name}: ${result.from} → ${result.to}`);
      return formatError(result.error);
    }
    default:
      return null; // 未匹配的命令
  }
}

/**
 * 处理飞书事件回调
 */
async function handleEvent(event: FeishuMessage): Promise<void> {
  const chatId = event.header.chat_id;
  const messageType = event.header.message_type as string;

  // 只处理私聊消息
  if (event.header.chat_type !== 'private') {
    log.dim(`[飞书] 忽略群聊消息: ${chatId}`);
    return;
  }

  // 获取发送者信息
  const senderId = event.event.sender_id?.id || event.event.sender_id?.string_id || '';
  const senderName = event.event.sender_id?.name || `user_${senderId}`;

  // 获取消息内容
  let text = event.event.body?.content || '';

  // 解密消息（如果需要）
  if (messageType === 'encrypted' || messageType === 'encrypt') {
    text = api.decryptMessage(text);
  }

  if (!text) {
    log.dim(`[飞书] 忽略空消息`);
    return;
  }

  log.dim(`[飞书] ${senderName}: ${text.slice(0, 80)}`);

  try {
    // 处理内置命令
    if (text === '/start') {
      const role = isAdminFeishuUser(senderId) ? '管理员' : '普通用户';
      await api.sendText(chatId,
        `👋 欢迎使用衍语展业助手！\n\n` +
        `你的身份：${role}\n\n` +
        `你可以：\n` +
        `• 直接输入自然语言提问\n` +
        `• 使用 /help 查看可用命令\n` +
        `• 使用 /reset 重置对话上下文`
      );
      return;
    }

    if (text === '/help') {
      await api.sendText(chatId,
        `📋 *衍语 Bot 命令*\n\n` +
        `*基础命令：*\n` +
        `/start - 开始使用\n` +
        `/help - 查看帮助\n` +
        `/reset - 重置对话上下文\n` +
        `/status - 客户状态看板\n\n` +
        `*查询命令：*\n` +
        `/list - 客户列表\n` +
        `/view <名称> - 查看客户详情\n` +
        `/history <名称> - 操作历史\n` +
        `/trade <参数> - 交易查询\n` +
        `/faq <关键词> - 搜索知识库\n\n` +
        `*管理命令（仅管理员）：*\n` +
        `/add <名称> - 添加客户\n` +
        `/advance <名称> - 推进状态\n\n` +
        `💡 也可以直接输入自然语言，AI 助手会帮你处理！`
      );
      return;
    }

    if (text === '/reset') {
      resetSession(senderId);
      await api.sendText(chatId, '✅ 对话上下文已重置');
      return;
    }

    // /model 命令：查看或切换 LLM provider
    if (text.startsWith('/model')) {
      if (!isAdminFeishuUser(senderId)) {
        await api.sendText(chatId, '❌ 仅管理员可切换模型');
        return;
      }
      const arg = text.replace(/^\/model\s*/, '').trim();
      if (!arg || arg === 'list') {
        const available = getAvailableProviders();
        const current = getProviderName();
        const lines = available.map(p => `${p === current ? '▶ ' : '  '}${p}`);
        await api.sendText(chatId, `当前: ${current} / ${getModelName()}\n\n可用 provider:\n${lines.join('\n')}`);
      } else {
        const ok = switchProvider(arg as ProviderName);
        if (ok) {
          await api.sendText(chatId, `✅ 已切换到 ${getProviderName()} / ${getModelName()}`);
        } else {
          await api.sendText(chatId, `❌ 未知 provider: ${arg}\n可用: ${getAvailableProviders().join(', ')}`);
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
        await api.sendText(chatId, reply);
        return;
      }
      // 未匹配的命令，fallthrough 到 AI Agent
    }

    // 自然语言 → AI Agent
    const reply = await handleAIChat(chatId, text, senderId, senderName);
    await api.sendText(chatId, reply);

  } catch (err: any) {
    log.error(`[飞书] 处理消息出错: ${err.message}`);
    try {
      await api.sendText(chatId, `❌ 处理出错: ${err.message}`);
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
 */
export async function handleWebhookRequest(
  headers: Record<string, string | string[] | undefined>,
  body: any
): Promise<{ status: number; body: any }> {
  const timestamp = headers['x-feishu-timestamp'] as string || '';
  const nonce = headers['x-feishu-nonce'] as string || '';
  const signature = headers['x-feishu-signature'] as string || '';

  // 验证签名（可选，生产环境建议启用）
  // if (!verifySignature(timestamp, nonce, signature, JSON.stringify(body))) {
  //   log.warn('[飞书] 签名验证失败');
  //   return { status: 401, body: { error: 'invalid signature' } };
  // }

  // 处理验证挑战（飞书机器人配置时的验证）
  const config = loadFeishuConfig();
  if (body.type === 'url_verification') {
    return {
      status: 200,
      body: {
        challenge: body.challenge,
      },
    };
  }

  // 处理事件回调
  if (body.type === 'event_callback') {
    const event = body.event as FeishuMessage;
    if (event && event.event && event.event.type === 'message') {
      // 异步处理，不阻塞响应
      handleEvent(event).catch(err => {
        log.error(`[飞书] 处理事件出错: ${err.message}`);
      });
    }

    return {
      status: 200,
      body: { code: 0 },
    };
  }

  return {
    status: 200,
    body: { code: 0 },
  };
}

/**
 * 启动飞书 Bot（Web 服务模式）
 * 需要配合 HTTP 服务器（如 Express）接收 Webhook
 */
export async function startFeishuBot(): Promise<void> {
  if (running) {
    log.warn('[飞书] Bot 已在运行中');
    return;
  }

  const feishuConfig = loadFeishuConfig();

  if (!feishuConfig.appId || !feishuConfig.appSecret) {
    log.error('[飞书] 未配置 appId/appSecret，请在 config/monitor.json 中设置 feishu.appId 和 feishu.appSecret');
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
  } catch (err: any) {
    log.error(`[飞书] API 连接失败: ${err.message}`);
    return;
  }

  // 定时清理过期会话（每 30 分钟）
  cleanupTimer = setInterval(() => {
    const cleaned = cleanupSessions();
    if (cleaned > 0) log.dim(`[飞书] 清理了 ${cleaned} 个过期会话`);
  }, 30 * 60 * 1000);

  running = true;
  log.success('[飞书] Bot 已启动（Webhook 模式）');
}

/**
 * 停止飞书 Bot
 */
export function stopFeishuBot(): void {
  if (!running) {
    log.warn('[飞书] Bot 未在运行');
    return;
  }
  running = false;
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  log.success('[飞书] Bot 已停止');
}

/**
 * 查询 Bot 是否运行中
 */
export function isFeishuBotRunning(): boolean {
  return running;
}
