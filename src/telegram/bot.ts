/**
 * 衍语 Telegram Bot
 *
 * 支持两种交互模式：
 * 1. /command — 直接调用命令函数，格式化后返回（不经过 LLM）
 * 2. 自然语言 — 由 AI Agent 处理
 *
 * 架构：长轮询 + 每用户独立会话 + 命令直通 + 自然语言走 agent
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TelegramAPI, type TgMessage } from './api.js';
import { getSession, resetSession, setAdminIds, cleanupSessions, isAdminTelegramUser } from './session.js';
import { getProvider, getModelName, switchProvider, getProviderName, getAvailableProviders, type ProviderName } from '../llm/provider.js';
import { setCurrentUser, type User } from '../auth/rbac.js';
import { runAgenticChat } from '../llm/agent.js';
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

interface TelegramBotConfig {
  botToken: string;
  chatId?: string;
  proxy?: string;
}

function loadTelegramConfig(): TelegramBotConfig {
  const file = resolve(process.cwd(), 'config/monitor.json');
  const config = JSON.parse(readFileSync(file, 'utf-8'));
  return config.telegram as TelegramBotConfig;
}

let api: TelegramAPI;
let running = false;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 处理 AI 对话（含 tool use 循环）
 */
async function handleAIChat(chatId: number, userInput: string, telegramUserId: number, telegramUsername: string): Promise<string> {
  const session = getSession(telegramUserId, telegramUsername);

  // 临时切换当前用户上下文（tool handler 依赖）
  setCurrentUser(session.user);

  const textReply = await runAgenticChat(session.history, userInput, session.user, {
    streamEnabled: false,
    logPrefix: `[TG:${telegramUsername}] `,
    showThinking: true,
  });

  return textReply || '（无回复内容）';
}

/**
 * 直接处理 /command，不经过 LLM
 * 返回格式化后的文本，或 null 表示未匹配到命令
 */
async function handleCommand(cmd: string, args: string, telegramUserId: number): Promise<string | null> {
  switch (cmd) {
    case 'status': {
      const data = fetchSystemStatus();
      return formatSystemStatus(data);
    }
    case 'client': {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || '').toLowerCase();
      const rest = parts.slice(1).join(' ');
      return handleClientSubcommand(sub, rest, telegramUserId);
    }
    // keep old top-level aliases working
    case 'list':    return handleClientSubcommand('list', args, telegramUserId);
    case 'view':    return handleClientSubcommand('view', args, telegramUserId);
    case 'history': return handleClientSubcommand('history', args, telegramUserId);
    case 'add':     return handleClientSubcommand('add', args, telegramUserId);
    case 'advance': return handleClientSubcommand('advance', args, telegramUserId);
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
    default:
      return null; // 未匹配的命令
  }
}

function handleClientSubcommand(sub: string, rest: string, telegramUserId: number): string | null {
  switch (sub) {
    case 'list': case '': {
      const filter: { state?: string; keyword?: string } = {};
      const stateMatch = rest.match(/state=(\S+)/);
      if (stateMatch) filter.state = stateMatch[1];
      const remaining = rest.replace(/state=\S+/, '').trim();
      if (remaining) filter.keyword = remaining;
      const clients = fetchClients(Object.keys(filter).length > 0 ? filter : undefined);
      return formatClientList(clients);
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
      if (!isAdminTelegramUser(telegramUserId)) return formatError('权限不足：该命令需要管理员权限');
      if (!rest) return formatError('用法: /client add <名称> [contact=xx] [wework_group=xx] [sales=xx]');
      const session = getSession(telegramUserId, '');
      setCurrentUser(session.user);
      const result = addClient(rest);
      if (result.success) return formatSuccess(`客户已添加: ${result.name} (${result.id})`);
      return formatError(result.error);
    }
    case 'advance': {
      if (!isAdminTelegramUser(telegramUserId)) return formatError('权限不足：该命令需要管理员权限');
      if (!rest) return formatError('用法: /client advance <客户名称或ID>');
      const session = getSession(telegramUserId, '');
      setCurrentUser(session.user);
      const result = advanceClient(rest);
      if (result.success) return formatSuccess(`${result.name}: ${result.from} → ${result.to}`);
      return formatError(result.error);
    }
    default:
      return formatError('用法: /client <list|view|history|add|advance> [参数]');
  }
}

/**
 * 处理单条消息
 */
async function handleMessage(msg: TgMessage): Promise<void> {
  if (!msg.text || !msg.from) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || `user_${userId}`;
  const text = msg.text.trim();

  // 只处理私聊消息（可扩展到群聊）
  if (msg.chat.type !== 'private') {
    // 群聊中只响应 @bot 或 /command
    if (!text.startsWith('/')) return;
  }

  log.dim(`[TG] ${username}: ${text.slice(0, 80)}`);

  try {
    // 处理内置命令
    if (text === '/start') {
      const role = isAdminTelegramUser(userId) ? '管理员' : '普通用户';
      await api.sendMessage(chatId,
        `👋 欢迎使用 OTC Claw！\n\n` +
        `你的身份：${role}\n\n` +
        `你可以：\n` +
        `• 直接输入自然语言提问\n` +
        `• 使用 /help 查看可用命令\n` +
        `• 使用 /reset 重置对话上下文`
      );
      return;
    }

    if (text === '/help') {
      await api.sendMessage(chatId,
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
        `💡 也可以直接输入自然语言，AI 助手会帮你处理！`,
        'Markdown'
      );
      return;
    }

    if (text === '/reset') {
      resetSession(userId);
      await api.sendMessage(chatId, '✅ 对话上下文已重置');
      return;
    }

    // /model 命令：查看或切换 LLM provider
    if (text.startsWith('/model')) {
      if (!isAdminTelegramUser(userId)) {
        await api.sendMessage(chatId, '❌ 仅管理员可切换模型');
        return;
      }
      const arg = text.replace(/^\/model\s*/, '').trim();
      if (!arg || arg === 'list') {
        const available = getAvailableProviders();
        const current = getProviderName();
        const lines = available.map(p => `${p === current ? '▶ ' : '  '}${p}`);
        await api.sendMessage(chatId, `当前: ${current} / ${getModelName()}\n\n可用 provider:\n${lines.join('\n')}`);
      } else {
        const ok = switchProvider(arg as ProviderName);
        if (ok) {
          await api.sendMessage(chatId, `✅ 已切换到 ${getProviderName()} / ${getModelName()}`);
        } else {
          await api.sendMessage(chatId, `❌ 未知 provider: ${arg}\n可用: ${getAvailableProviders().join(', ')}`);
        }
      }
      return;
    }

    // 发送 typing 状态
    await api.sendChatAction(chatId);

    // /command 格式 → 直接调用命令函数，不经过 LLM
    if (text.startsWith('/')) {
      const cleaned = text.replace(/@\w+/, '').trim();
      const spaceIdx = cleaned.indexOf(' ');
      const cmd = (spaceIdx > 0 ? cleaned.slice(1, spaceIdx) : cleaned.slice(1)).toLowerCase();
      const args = spaceIdx > 0 ? cleaned.slice(spaceIdx + 1).trim() : '';

      const reply = await handleCommand(cmd, args, userId);
      if (reply !== null) {
        await api.sendMessage(chatId, reply);
        return;
      }
      // 未匹配的命令，fallthrough 到 AI Agent
    }

    // 自然语言 → AI Agent
    const reply = await handleAIChat(chatId, text, userId, username);
    await api.sendMessage(chatId, reply);

  } catch (err: any) {
    log.error(`[TG] 处理消息出错: ${err.message}`);
    try {
      await api.sendMessage(chatId, `❌ 处理出错: ${err.message}`);
    } catch { /* ignore send error */ }
  }
}

/**
 * 长轮询主循环
 */
async function pollLoop(): Promise<void> {
  log.info('[TG] 开始长轮询...');
  while (running) {
    try {
      const updates = await api.getUpdates(30);
      for (const update of updates) {
        if (update.message) {
          // 不阻塞轮询，异步处理每条消息
          handleMessage(update.message).catch(err => {
            log.error(`[TG] 消息处理异常: ${err.message}`);
          });
        }
      }
    } catch (err: any) {
      if (running) {
        log.error(`[TG] 轮询出错: ${err.message}`);
        // 出错后等待 5 秒重试
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
}

/**
 * 启动 Telegram Bot（非阻塞，后台轮询）
 * 数据库和 Claude 应由调用方事先初始化
 */
export async function startTelegramBot(): Promise<void> {
  if (running) {
    log.warn('[TG] Bot 已在运行中');
    log.print('[TG] Bot 已在运行中');
    return;
  }

  const tgConfig = loadTelegramConfig();
  const token = tgConfig.botToken;
  if (!token) {
    log.error('[TG] 未配置 botToken，请在 config/monitor.json 中设置 telegram.botToken');
    log.print('[TG] 未配置 botToken，请在 config/monitor.json 中设置 telegram.botToken');
    return;
  }

  // 解析管理员 Telegram ID 列表
  const adminIdsStr = process.env.TELEGRAM_ADMIN_IDS || '';
  const adminIdList = adminIdsStr
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));
  setAdminIds(adminIdList);

  if (adminIdList.length === 0) {
    log.warn('[TG] 未配置 TELEGRAM_ADMIN_IDS，所有用户将以只读身份使用');
  } else {
    log.info(`[TG] 管理员 Telegram IDs: ${adminIdList.join(', ')}`);
  }

  // 初始化 Telegram API（带代理）
  api = new TelegramAPI(token, tgConfig.proxy);

  // 验证 token
  try {
    const me = await api.getMe();
    log.success(`[TG] Bot 已连接: @${me.username} (${me.first_name})`);
    log.print(`[TG] Bot 已连接: @${me.username} (${me.first_name})`);
  } catch (err: any) {
    log.error(`[TG] Bot token 无效: ${err.message}`);
    log.print(`[TG] Bot token 无效: ${err.message}`);
    return;
  }

  // 设置命令菜单
  try {
    await api.setMyCommands([
      { command: 'start', description: '开始使用' },
      { command: 'help', description: '查看帮助' },
      { command: 'reset', description: '重置对话上下文' },
      { command: 'status', description: '系统状态' },
      { command: 'client', description: '客户管理' },
      { command: 'trade', description: '交易查询' },
      { command: 'faq', description: '搜索知识库' },
    ]);
  } catch { /* non-critical */ }

  // 定时清理过期会话（每 30 分钟）
  cleanupTimer = setInterval(() => {
    const cleaned = cleanupSessions();
    if (cleaned > 0) log.dim(`[TG] 清理了 ${cleaned} 个过期会话`);
  }, 30 * 60 * 1000);

  // 后台开始轮询（不阻塞）
  running = true;
  pollLoop().catch(err => {
    log.error(`[TG] 轮询异常退出: ${err.message}`);
    running = false;
  });
}

/**
 * 停止 Telegram Bot
 */
export function stopTelegramBot(): void {
  if (!running) {
    log.warn('[TG] Bot 未在运行');
    log.print('[TG] Bot 未在运行');
    return;
  }
  running = false;
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  log.success('[TG] Bot 已停止');
  log.print('[TG] Bot 已停止');
}

/**
 * 查询 Bot 是否运行中
 */
export function isTelegramBotRunning(): boolean {
  return running;
}
