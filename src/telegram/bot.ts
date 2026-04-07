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
import { getSession, resetSession, cleanupSessions } from './session.js';
import { getProvider, getModelName, switchProvider, getProviderName, getAvailableProviders, type ProviderName } from '../llm/provider.js';
import { setCurrentUser, type User, isAgentAdmin } from '../auth/rbac.js';
import { runAgenticChat, setCurrentAgent, type DeliveryContext } from '../llm/agent.js';
import { getAgent, AgentUnboundError } from '../llm/agents/config.js';
import { log } from '../utils/logger.js';
import { getCommandEntries } from '../commands/router.js';
import { fetchSystemStatus, formatSystemStatus } from '../commands/monitor.js';
import { fetchKnowledge } from '../commands/knowledge.js';
import { getAllSkills } from '../commands/skill.js';
import {
  formatKnowledge, formatSkillList,
  formatError,
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

  // 解析当前 session 使用的 Agent
  const agentConfig = getAgent(session.agentName);

  const textReply = await runAgenticChat(session.history, userInput, session.user, {
    streamEnabled: false,
    logPrefix: `[TG:${telegramUsername}] `,
    showThinking: true,
    agentConfig,
    deliveryContext: {
      channel: 'telegram',
      targetId: String(chatId),
    } as DeliveryContext,
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
    case 'agent': {
      return handleAgentCommand(args, telegramUserId);
    }
    default:
      return null;
  }
}

function handleAgentCommand(args: string, telegramUserId: number): string {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();

  // /agent — show current agent
  if (!sub) {
    const session = getSession(telegramUserId, '');
    const agent = getAgent(session.agentName);
    return `当前 Agent: ${agent.displayName} (${agent.name})\n${agent.description || ''}`;
  }

  return '❌ `/agent` 的 list/switch/assign 等管理操作仅支持 CLI channel';
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
      const role = isAgentAdmin(getSession(userId, '').agentName) ? 'agent admin' : 'member';
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
      const session = getSession(userId, username);
      const agentConfig = getAgent(session.agentName);
      setCurrentUser(session.user);
      setCurrentAgent(agentConfig);
      const entries = getCommandEntries();
      const lines = ['📋 可用命令：', ''];
      for (const e of entries) {
        lines.push(`${e.name} — ${e.description}`);
        if (e.usage) lines.push(`  用法: ${e.usage}`);
      }
      lines.push('', '💡 也可以直接输入自然语言，AI 助手会帮你处理！');
      await api.sendMessage(chatId, lines.join('\n'));
      return;
    }

    if (text === '/reset') {
      resetSession(userId);
      await api.sendMessage(chatId, '✅ 对话上下文已重置');
      return;
    }

    // /model 命令：查看或切换 LLM provider
    if (text.startsWith('/model')) {
      if (!isAgentAdmin(getSession(userId, '').agentName)) {
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
    if (err instanceof AgentUnboundError) {
      log.warn(`[TG] ${err.message}`);
      try { await api.sendMessage(chatId, `⚠️ ${err.message}`); } catch { /* ignore */ }
      return;
    }
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
