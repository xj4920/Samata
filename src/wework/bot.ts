/**
 * 企业微信 Bot
 *
 * 支持 HTTP 回调模式（企微只支持 webhook，不支持长连接）
 *
 * 消息处理流程：
 * 1. /command → 直接调用命令函数，不经过 LLM
 * 2. 自然语言 → runAgenticChat()
 *
 * 回复方式：
 * - 被动回复（5秒内）：XML 加密响应
 * - 主动发送（超时后）：调用企微消息 API（需要 agentSecret）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WeworkAPI, type WeworkConfig, type WeworkMessage } from './api.js';
import { getSession, resetSession, cleanupSessions } from './session.js';
import { setCurrentUser, getCurrentUser, isAgentAdmin } from '../auth/rbac.js';
import { runAgenticChat } from '../llm/agent.js';
import { getAgent } from '../llm/agents/config.js';
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
import { getProvider, getModelName, switchProvider, getProviderName, getAvailableProviders, type ProviderName } from '../llm/provider.js';

let api: WeworkAPI;
let running = false;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function loadWeworkConfig(): WeworkConfig {
  const file = resolve(process.cwd(), 'config/monitor.json');
  const config = JSON.parse(readFileSync(file, 'utf-8'));
  return config.wework as WeworkConfig;
}

/**
 * 处理 AI 对话（复用 runAgenticChat，遵循 CLAUDE.md 规范）
 */
async function handleAIChat(
  userInput: string,
  weworkUserId: string,
  weworkUsername: string,
): Promise<string> {
  const session = getSession(weworkUserId, weworkUsername);
  const prevUser = getCurrentUser();
  setCurrentUser(session.user);

  try {
    const agentConfig = getAgent(session.agentName);

    // 控制历史长度
    const MAX_HISTORY = 20;
    while (session.history.length > MAX_HISTORY * 2) {
      session.history.shift();
    }

    const textReply = await runAgenticChat(session.history, userInput, session.user, {
      streamEnabled: false,
      logPrefix: `[企微:${weworkUsername}] `,
      showThinking: true,
      agentConfig,
    });

    return textReply || '（无回复内容）';
  } finally {
    setCurrentUser(prevUser);
  }
}

async function handleCommand(cmd: string, args: string, weworkUserId: string): Promise<string | null> {
  switch (cmd) {
    case 'status': {
      const data = fetchSystemStatus();
      return formatSystemStatus(data);
    }
    case 'client': {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || '').toLowerCase();
      const rest = parts.slice(1).join(' ');
      return handleClientSubcommand(sub, rest, weworkUserId);
    }
    case 'list':    return handleClientSubcommand('list', args, weworkUserId);
    case 'view':    return handleClientSubcommand('view', args, weworkUserId);
    case 'history': return handleClientSubcommand('history', args, weworkUserId);
    case 'add':     return handleClientSubcommand('add', args, weworkUserId);
    case 'advance': return handleClientSubcommand('advance', args, weworkUserId);
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
      return null;
    }
    case 'agent':
      return handleAgentCommand(args, weworkUserId);
    default:
      return null;
  }
}

async function handleClientSubcommand(sub: string, rest: string, weworkUserId: string): Promise<string | null> {
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
      if (!isAgentAdmin(getSession(weworkUserId, '').agentName)) return formatError('权限不足：该命令需要管理员权限');
      const prevUser = getCurrentUser();
      const session = getSession(weworkUserId, '');
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
      if (!isAgentAdmin(getSession(weworkUserId, '').agentName)) return formatError('权限不足：该命令需要管理员权限');
      const prevUser = getCurrentUser();
      const session = getSession(weworkUserId, '');
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

function handleAgentCommand(args: string, weworkUserId: string): string {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();

  if (!sub) {
    const session = getSession(weworkUserId, '');
    const agent = getAgent(session.agentName);
    return `当前 Agent: ${agent.displayName} (${agent.name})\n${agent.description || ''}`;
  }

  return '`/agent` 的 list/switch 等管理操作仅支持 CLI channel';
}

/**
 * 处理企微消息事件
 * 返回被动回复 XML（或 'success' 表示无需回复）
 */
async function handleEvent(message: WeworkMessage): Promise<string> {
  const userId = message.fromUserName;
  const corpId = message.toUserName;

  log.info(`[企微] 收到消息: from=${userId}, type=${message.msgType}`);

  // 忽略非文本消息（暂不支持图片、语音等）
  if (message.msgType !== 'text') {
    if (message.msgType === 'event') {
      log.dim(`[企微] 收到事件: ${message.event}`);
    } else {
      log.dim(`[企微] 暂不支持消息类型: ${message.msgType}`);
    }
    return 'success';
  }

  const text = (message.content || '').trim();
  if (!text) return 'success';

  const username = `user_${userId.slice(-6)}`;
  log.dim(`[企微] ${username}: ${text.slice(0, 80)}`);

  let reply = '';

  try {
    // 内置命令
    if (text === '/start') {
      const role = isAgentAdmin(getSession(userId, '').agentName) ? 'agent admin' : 'member';
      reply = `欢迎使用 OTC Claw！\n\n你的身份：${role}\n\n你可以：\n• 直接输入自然语言提问\n• 使用 /help 查看可用命令\n• 使用 /reset 重置对话上下文`;
    } else if (text === '/help') {
      reply = `OTC Claw Bot 命令\n\n基础命令：\n/start - 开始使用\n/help - 查看帮助\n/reset - 重置对话上下文\n/status - 系统状态\n\n客户管理：\n/client list [state=xx] - 客户列表\n/client view <名称> - 查看客户详情\n/client history <名称> - 操作历史\n/client add <名称> - 添加客户（管理员）\n/client advance <名称> - 推进状态（管理员）\n\n查询命令：\n/trade <参数> - 交易查询\n/faq <关键词> - 搜索知识库\n\nAgent 管理：\n/agent - 查看当前 Agent\n其他 Agent 管理操作仅支持 CLI\n\n也可以直接输入自然语言，AI 助手会帮你处理！`;
    } else if (text === '/reset') {
      resetSession(userId);
      reply = '对话上下文已重置';
    } else if (text.startsWith('/debug')) {
      reply = `你的企微用户 ID: ${userId}`;
    } else if (text.startsWith('/model')) {
      if (!isAgentAdmin(getSession(userId, '').agentName)) {
        reply = '仅管理员可切换模型';
      } else {
        const arg = text.replace(/^\/model\s*/, '').trim();
        if (!arg || arg === 'list') {
          const available = getAvailableProviders();
          const current = getProviderName();
          const lines = available.map(p => `${p === current ? '▶ ' : '  '}${p}`);
          reply = `当前: ${current} / ${getModelName()}\n\n可用 provider:\n${lines.join('\n')}`;
        } else {
          const ok = switchProvider(arg as ProviderName);
          reply = ok
            ? `已切换到 ${getProviderName()} / ${getModelName()}`
            : `未知 provider: ${arg}\n可用: ${getAvailableProviders().join(', ')}`;
        }
      }
    } else if (text.startsWith('/')) {
      // /command 格式 → 直接调用命令函数
      const cleaned = text.trim();
      const spaceIdx = cleaned.indexOf(' ');
      const cmd = (spaceIdx > 0 ? cleaned.slice(1, spaceIdx) : cleaned.slice(1)).toLowerCase();
      const args = spaceIdx > 0 ? cleaned.slice(spaceIdx + 1).trim() : '';

      const cmdReply = await handleCommand(cmd, args, userId);
      if (cmdReply !== null) {
        reply = cmdReply;
      } else {
        // 未匹配的命令，fallthrough 到 AI Agent
        reply = await handleAIChat(text, userId, username);
      }
    } else {
      // 自然语言 → AI Agent
      reply = await handleAIChat(text, userId, username);
    }
  } catch (err: any) {
    log.error(`[企微] 处理消息出错: ${err.message}`);
    reply = `处理出错: ${err.message}`;
  }

  // 截断超长回复（企微文本消息限制 2048 字符）
  if (reply.length > 2000) {
    reply = reply.slice(0, 1997) + '...';
  }

  return api.buildReply(userId, corpId, reply);
}

/**
 * 处理 HTTP Webhook 请求
 */
export async function handleWebhookRequest(
  method: string,
  query: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string; contentType: string }> {
  // GET 请求：URL 验证挑战
  if (method === 'GET' && query.echostr) {
    try {
      const echostr = api.replyEchostr(query.echostr, query);
      log.success('[企微] URL 验证成功');
      return { status: 200, body: echostr, contentType: 'text/plain' };
    } catch (err: any) {
      log.error(`[企微] URL 验证失败: ${err.message}`);
      return { status: 403, body: 'Forbidden', contentType: 'text/plain' };
    }
  }

  // POST 请求：接收消息
  if (method === 'POST' && body) {
    try {
      const message = api.parseCallback(query, body);
      const replyXml = await handleEvent(message);

      if (replyXml === 'success') {
        return { status: 200, body: 'success', contentType: 'text/plain' };
      }
      return { status: 200, body: replyXml, contentType: 'application/xml' };
    } catch (err: any) {
      log.error(`[企微] 处理回调出错: ${err.message}`);
      return { status: 200, body: 'success', contentType: 'text/plain' };
    }
  }

  return { status: 200, body: 'success', contentType: 'text/plain' };
}

export async function startWeworkBot(): Promise<void> {
  if (running) return;

  const config = loadWeworkConfig();
  api = new WeworkAPI(config);
  running = true;

  // 定期清理过期会话
  cleanupTimer = setInterval(() => {
    const cleaned = cleanupSessions();
    if (cleaned > 0) log.dim(`[企微] 清理过期会话: ${cleaned} 个`);
  }, 30 * 60 * 1000);

  log.success('[企微] Bot 已启动（webhook 模式）');
}

export function stopWeworkBot(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  running = false;
  log.info('[企微] Bot 已停止');
}

export function isWeworkBotRunning(): boolean {
  return running;
}
