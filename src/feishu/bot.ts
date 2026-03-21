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
 *
 * 多应用支持：
 * - 每个飞书应用独立运行（独立实例、会话、连接）
 * - 应用级 Agent 绑定（一个应用对应一个 Agent）
 */
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuAPI, type FeishuConfig, type FeishuMessage } from './api.js';
import { buildCard, buildThinkingCard } from './card.js';
import { setAdminIds, isAdminFeishuUser } from './session.js';
import { getProvider, getModelName, switchProvider, getProviderName, getAvailableProviders, type ProviderName } from '../llm/provider.js';
import { setCurrentUser, getCurrentUser } from '../auth/rbac.js';
import { runAgenticChat, type ImageInput, type DeliveryContext, detectImageMediaType, setCurrentAgent, getCurrentAgent } from '../llm/agent.js';
import { getAgent, getAllAgents, saveAssignment, deleteAssignment, listAssignments, resolveAgent, type FeishuAppRow } from '../llm/agents/config.js';
import { getDb } from '../db/connection.js';
import { log } from '../utils/logger.js';
import { fetchClients, fetchClient, fetchHistory, addClient, advanceClient } from '../commands/client.js';
import { getCommandEntries } from '../commands/router.js';
import { fetchSystemStatus, formatSystemStatus } from '../commands/monitor.js';
import { fetchTrades } from '../commands/trade.js';
import { fetchKnowledge } from '../commands/knowledge.js';
import { getAllSkills } from '../commands/skill.js';
import { fetchMemory, saveMemory, deleteMemory, searchMemory } from '../llm/agents/memory.js';
import {
  formatClientList, formatClientDetail,
  formatClientHistory, formatTrades, formatKnowledge, formatSkillList,
  formatSuccess, formatError,
} from './formatter.js';

type FeishuAppConfig = {
  appId: string;
  appName: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  showThinking?: boolean;
};

interface FeishuSession {
  feishuUserId: string;
  feishuUsername: string;
  user: { id: string; username: string; role: 'admin' | 'user' };
  history: Anthropic.MessageParam[];
  lastActive: number;
  agentName: string;
}

interface FeishuBotInstance {
  appId: string;
  appName: string;
  config: FeishuAppConfig;
  api: FeishuAPI;
  wsClient: InstanceType<typeof Lark.WSClient> | null;
  httpServer: ReturnType<typeof createServer> | null;
  botOpenId: string;
  cleanupTimer: ReturnType<typeof setInterval> | null;
  sessions: Map<string, FeishuSession>;
}

const botInstances = new Map<string, FeishuBotInstance>();

function loadFeishuConfig(appId: string): FeishuAppConfig | undefined {
  const row = getDb().prepare('SELECT * FROM feishu_apps WHERE app_id = ?').get(appId) as FeishuAppRow | undefined;
  if (!row) return undefined;
  return {
    appId: row.app_id,
    appName: row.app_name,
    appSecret: row.app_secret,
    verificationToken: row.verification_token,
    encryptKey: row.encrypt_key,
    showThinking: row.show_thinking === 1,
  };
}

function loadAllFeishuConfigs(onlyAutoStart = true): FeishuAppConfig[] {
  const query = onlyAutoStart ? 'SELECT * FROM feishu_apps WHERE auto_start = 1' : 'SELECT * FROM feishu_apps';
  const rows = getDb().prepare(query).all() as FeishuAppRow[];
  return rows.map(r => ({
    appId: r.app_id,
    appName: r.app_name,
    appSecret: r.app_secret,
    verificationToken: r.verification_token,
    encryptKey: r.encrypt_key,
    showThinking: r.show_thinking === 1,
  }));
}

export type FeishuBotMode = 'ws' | 'webhook';

/**
 * 同步内存中的 Bot 实例与数据库状态
 */
export async function syncFeishuBots(options?: { mode?: FeishuBotMode; httpPort?: number }): Promise<void> {
  const mode = options?.mode ?? 'ws';
  const dbApps = getDb().prepare('SELECT app_id, auto_start FROM feishu_apps').all() as { app_id: string; auto_start: number }[];
  
  for (const row of dbApps) {
    const isRunning = botInstances.has(row.app_id);
    const shouldRun = row.auto_start === 1;

    if (shouldRun && !isRunning) {
      log.info(`[飞书] 检测到新配置或手动开启，正在启动 Bot: ${row.app_id}`);
      await startFeishuBot(row.app_id, options);
    } else if (!shouldRun && isRunning) {
      log.info(`[飞书] 检测到配置已关闭或手动停用，正在停止 Bot: ${row.app_id}`);
      stopFeishuBot(row.app_id);
    }
  }
}

/**
 * 启动轮询，自动同步数据库状态到运行中的 Bot
 */
let watchTimer: ReturnType<typeof setInterval> | null = null;
export function watchFeishuApps(options?: { mode?: FeishuBotMode; httpPort?: number }): void {
  if (watchTimer) return;
  
  log.info('[飞书] 启动数据库同步监控 (每 10s)...');
  watchTimer = setInterval(async () => {
    try {
      await syncFeishuBots(options);
    } catch (err: any) {
      log.error(`[飞书] 同步数据库状态出错: ${err.message}`);
    }
  }, 10000);
}

/**
 * 获取或创建会话（实例级）
 */
function getSessionForInstance(
  instance: FeishuBotInstance,
  feishuUserId: string,
  feishuUsername: string
): FeishuSession {
  let session = instance.sessions.get(feishuUserId);
  if (!session) {
    const role = isAdminFeishuUser(feishuUserId) ? 'admin' : 'user';
    const agent = resolveAgent('feishu', instance.appId);
    session = {
      feishuUserId,
      feishuUsername,
      user: {
        id: role === 'admin' ? 'admin-001' : 'user-001',
        username: feishuUsername || `feishu_${feishuUserId}`,
        role,
      },
      history: [],
      lastActive: Date.now(),
      agentName: agent.name,
    };
    instance.sessions.set(feishuUserId, session);
  }
  session.lastActive = Date.now();
  session.feishuUsername = feishuUsername || session.feishuUsername;
  return session;
}

/**
 * 重置会话（实例级）
 */
function resetSessionForInstance(instance: FeishuBotInstance, feishuUserId: string): boolean {
  const session = instance.sessions.get(feishuUserId);
  if (session) {
    session.history = [];
    const agent = resolveAgent('feishu', instance.appId);
    session.agentName = agent.name;
    return true;
  }
  return false;
}

/**
 * 清理过期会话（实例级）
 */
function cleanupSessionsForInstance(instance: FeishuBotInstance, maxAgeMs = 2 * 60 * 60 * 1000): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of instance.sessions) {
    if (now - session.lastActive > maxAgeMs) {
      instance.sessions.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * 处理 AI 对话（含 tool use 循环）
 */
async function handleAIChat(
  instance: FeishuBotInstance,
  chatId: string,
  userInput: string,
  feishuUserId: string,
  feishuUsername: string,
  images?: ImageInput[],
  replyOpts?: { messageId?: string; isGroup?: boolean },
): Promise<{ text: string }> {
  const session = getSessionForInstance(instance, feishuUserId, feishuUsername);
  const showThinkingEnabled = instance.config.showThinking !== false;

  // 发送过程卡片的辅助函数
  let progressMessageId: string | undefined;

  const sendProgressCard = async (hint: string) => {
    try {
      const card = buildThinkingCard(hint);
      if (progressMessageId) {
        // 如果已经有卡片了，尝试更新它
        try {
          await instance.api.updateCard(progressMessageId, card);
          return;
        } catch (updateErr: any) {
          log.dim(`[飞书:${instance.appName}] 更新过程卡片失败，尝试发送新卡片: ${updateErr.message}`);
          // 更新失败则重置，准备发新卡片
          progressMessageId = undefined;
        }
      }

      if (replyOpts?.isGroup && replyOpts?.messageId) {
        progressMessageId = await instance.api.replyMessage(replyOpts.messageId, 'interactive', JSON.stringify(card));
      } else {
        progressMessageId = await instance.api.sendCard(chatId, card);
      }
    } catch (err: any) {
      log.warn(`[飞书:${instance.appName}] 发送/更新过程卡片失败: ${err.message}`);
    }
  };

  // 发送初始占位卡片
  if (showThinkingEnabled) {
    await sendProgressCard('🤔 思考中...');
  }

  // 临时切换当前用户上下文（tool handler 依赖），处理完后恢复
  const prevUser = getCurrentUser();
  setCurrentUser(session.user);

  try {
    // 解析当前 session 使用的 Agent
    const agentConfig = getAgent(session.agentName);

    // 渐进发送过程卡片（节流 1.5s）
    let lastUpdateTime = 0;
    const THROTTLE_MS = 1500;
    const onProgress = showThinkingEnabled
      ? (event: import('../llm/agent.js').ProgressEvent) => {
          const now = Date.now();
          if (now - lastUpdateTime < THROTTLE_MS) return;
          lastUpdateTime = now;
          let hint = '';
          if (event.type === 'tool_start') hint = `🔧 正在调用 ${event.name}...`;
          else if (event.type === 'thinking') hint = `💭 ${event.text.slice(0, 80)}`;
          if (hint) {
            sendProgressCard(hint);
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
      deliveryContext: {
        channel: 'feishu',
        targetId: feishuUserId,
        appId: instance.appId,
      } as DeliveryContext,
    });

    // 关键修复：将 AI 的回复存入会话历史，确保后续对话能记得前面的内容
    if (textReply) {
      session.history.push({ role: 'assistant', content: textReply });
    }

    // 最终回复前，如果进度卡片还在，尝试直接用它进行回复（通过 updateCard）
    if (textReply && progressMessageId) {
      try {
        const finalReplyId = await sendFeishuReply(instance, chatId, textReply, {
          ...replyOpts,
          updateMessageId: progressMessageId
        });
        // 如果成功更新了卡片，返回空回复，通知外层不要再发新消息了
        if (finalReplyId === progressMessageId) {
          return { text: '' };
        }
      } catch (err: any) {
        log.warn(`[飞书:${instance.appName}] 尝试通过进度卡片返回最终结果失败: ${err.message}`);
      }
    }

    return { text: textReply || '（无回复内容）' };
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
  instance: FeishuBotInstance,
  chatId: string,
  text: string,
  options?: { messageId?: string; isGroup?: boolean; updateMessageId?: string }
): Promise<string> {
  const MAX_LEN = 4000;

  // 更新已有卡片模式
  if (options?.updateMessageId) {
    try {
      const card = buildCard(text.length > MAX_LEN ? text.slice(-MAX_LEN) : text);
      await instance.api.updateCard(options.updateMessageId, card);
      return options.updateMessageId;
    } catch (err: any) {
      log.warn(`[飞书:${instance.appName}] 更新卡片失败，回退到发新消息: ${err.message}`);
      // fallthrough 到下面的发新消息逻辑
    }
  }

  const useReply = options?.isGroup && options?.messageId;

  if (!text || text === '（无回复内容）') {
    if (useReply) {
      return instance.api.replyMessage(options.messageId!, 'text', { text: text || '（无回复内容）' });
    } else {
      return instance.api.sendText(chatId, text || '（无回复内容）');
    }
  }

  // 分批发送卡片逻辑
  const MAX_TABLES = 4;
  const chunks: string[] = [];
  const blocks = text.split('\n\n');
  
  let currentChunk = '';
  let currentTables = 0;

  for (const block of blocks) {
    const tableCount = (block.match(/^ *\|? *[-:]+ *\| *[-:| ]*$/gm) || []).length;

    // 检查加入这个 block 是否会超出长度或表格数量限制
    if (
      (currentChunk.length > 0 && currentChunk.length + block.length + 2 > MAX_LEN) ||
      (currentTables + tableCount > MAX_TABLES)
    ) {
      // 达到限制，先把 currentChunk 送到 chunks
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
        currentTables = 0;
      }
      
      // 如果 block 自身仍然超出限制，按行硬切分
      if (block.length > MAX_LEN || tableCount > MAX_TABLES) {
        const lines = block.split('\n');
        let blockChunk = '';
        let blockChunkTables = 0;
        
        for (const line of lines) {
           const isTableDivider = /^ *\|? *[-:]+ *\| *[-:| ]*$/.test(line);
           const lineTableCount = isTableDivider ? 1 : 0;
           
           if (
             (blockChunk.length > 0 && blockChunk.length + line.length + 1 > MAX_LEN) ||
             (blockChunkTables + lineTableCount > MAX_TABLES)
           ) {
              chunks.push(blockChunk.trim());
              blockChunk = line;
              blockChunkTables = lineTableCount;
           } else {
              if (blockChunk) blockChunk += '\n';
              blockChunk += line;
              blockChunkTables += lineTableCount;
           }
        }
        
        // 跑完这一个大 block 的 lines 后，如果还有剩余
        if (blockChunk) {
           currentChunk = blockChunk;
           currentTables = blockChunkTables;
        }
      } else {
        // block 本身符合限制，但之前没和旧 chunk 凑一起，现在放到新的 currentChunk 中
        currentChunk = block;
        currentTables = tableCount;
      }
    } else {
      // 可以安全把 block 并入 currentChunk
      if (currentChunk) {
        currentChunk += '\n\n' + block;
      } else {
        currentChunk = block;
      }
      currentTables += tableCount;
    }
  }

  // 收尾最后一个 chunk
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  let lastMessageId = '';
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i];
    try {
      const card = buildCard(chunkText);
      if (useReply) {
        lastMessageId = await instance.api.replyMessage(options.messageId!, 'interactive', JSON.stringify(card));
      } else {
        lastMessageId = await instance.api.sendCard(chatId, card);
      }
    } catch (err: any) {
      const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      log.error(`[飞书:${instance.appName}] Card 分片 ${i + 1}/${chunks.length} 发送失败: ${errorDetail}，回退到纯文本`);
      try {
        if (useReply) {
          lastMessageId = await instance.api.replyMessage(options.messageId!, 'text', { text: chunkText });
        } else {
          lastMessageId = await instance.api.sendText(chatId, chunkText);
        }
      } catch (e: any) {
         log.error(`[飞书:${instance.appName}] 纯文本降级发送依然失败: ${e.message}`);
      }
    }

    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return lastMessageId || '';
}

/**
 * 直接处理 /command，不经过 LLM
 * 返回格式化后的文本，或 null 表示未匹配到命令
 */
async function handleCommand(
  instance: FeishuBotInstance,
  cmd: string,
  args: string,
  feishuUserId: string
): Promise<string | null> {
  switch (cmd) {
    case 'status': {
      const data = fetchSystemStatus();
      return formatSystemStatus(data);
    }
    case 'client': {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || '').toLowerCase();
      const rest = parts.slice(1).join(' ');
      return handleClientSubcommand(instance, sub, rest, feishuUserId);
    }
    // keep old top-level aliases working
    case 'list':    return handleClientSubcommand(instance, 'list', args, feishuUserId);
    case 'view':    return handleClientSubcommand(instance, 'view', args, feishuUserId);
    case 'history': return handleClientSubcommand(instance, 'history', args, feishuUserId);
    case 'add':     return handleClientSubcommand(instance, 'add', args, feishuUserId);
    case 'advance': return handleClientSubcommand(instance, 'advance', args, feishuUserId);
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
        const session = getSessionForInstance(instance, feishuUserId, '');
        const agentId = getAgent(session.agentName).id;
        const skills = getAllSkills(agentId);
        return formatSkillList(skills);
      }
      return null; // skill save/run/del 需要更复杂的处理，走 AI
    }
    case 'agent': {
      return handleAgentCommand(instance, args, feishuUserId);
    }
    case 'memory': {
      return handleMemoryCommand(args, instance, feishuUserId);
    }
    default:
      return null; // 未匹配的命令
  }
}

async function handleClientSubcommand(
  instance: FeishuBotInstance,
  sub: string,
  rest: string,
  feishuUserId: string
): Promise<string | null> {
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
      const session = getSessionForInstance(instance, feishuUserId, '');
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
      const session = getSessionForInstance(instance, feishuUserId, '');
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

function handleMemoryCommand(args: string, instance: FeishuBotInstance, feishuUserId: string): string {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || 'list').toLowerCase();
  const rest = parts.slice(1).join(' ');

  const session = getSessionForInstance(instance, feishuUserId, '');
  const agentId = getAgent(session.agentName).id;

  if (sub === 'list' || sub === '') {
    const items = fetchMemory(agentId);
    if (items.length === 0) return '暂无已保存的记忆';
    return items.map(m =>
      `[${m.id.slice(0, 8)}] (${m.scope}${m.agentId ? '/' + m.agentId.slice(0, 8) : ''}) ${m.content}`
    ).join('\n');
  }

  if (sub === 'search') {
    if (!rest) return '用法: /memory search <关键词>';
    const items = searchMemory(rest, agentId);
    if (items.length === 0) return `未找到匹配的记忆: ${rest}`;
    return items.map(m => `[${m.id.slice(0, 8)}] ${m.content}`).join('\n');
  }

  if (sub === 'add') {
    if (!isAdminFeishuUser(feishuUserId)) return formatError('权限不足：该命令需要管理员权限');
    if (!rest) return '用法: /memory add <内容>';
    const result = saveMemory({ content: rest, scope: 'agent', agentId, source: 'manual' });
    if (!result.success) return `❌ ${(result as any).error}`;
    return `✅ 记忆已保存: ${rest}`;
  }

  if (sub === 'del' || sub === 'delete') {
    if (!isAdminFeishuUser(feishuUserId)) return formatError('权限不足：该命令需要管理员权限');
    if (!rest) return '用法: /memory del <id>';
    const result = deleteMemory(rest);
    if (!result.success) return `❌ ${(result as any).error}`;
    return `✅ 记忆已删除: ${rest}`;
  }

  return 'Memory 用法：\n/memory list\n/memory add <内容>\n/memory search <关键词>\n/memory del <id>';
}

function handleAgentCommand(instance: FeishuBotInstance, args: string, feishuUserId: string): string {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();

  // /agent — show current agent
  if (!sub) {
    const session = getSessionForInstance(instance, feishuUserId, '');
    const agent = getAgent(session.agentName);
    return `当前 Agent: ${agent.displayName} (${agent.name})\n${agent.description || ''}`;
  }

  // /agent list — list all agents
  if (sub === 'list') {
    const agents = getAllAgents();
    const session = getSessionForInstance(instance, feishuUserId, '');
    const lines = agents.map(a => {
      const marker = a.name === session.agentName ? '▶ ' : '  ';
      const idTag = `[${a.id.slice(0, 8)}]`;
      return `${marker}${a.displayName} (${a.name}) ${idTag}${a.description ? `  ${a.description}` : ''}`;
    });
    return `可用 Agent (实例列表):\n${lines.join('\n')}`;
  }

  // /agent assign <name> — assign agent to current app
  if (sub === 'assign') {
    const agentName = parts[1];
    if (!agentName) return '用法: /agent assign <agent_name>';

    const result = saveAssignment(agentName, 'feishu', instance.appId);
    if (!result.success) return `❌ ${result.error}`;

    // 重置所有会话（应用级切换）
    instance.sessions.clear();
    return `✅ 已将 ${agentName} 绑定到当前应用，所有用户下次对话生效`;
  }

  // /agent unassign — remove app assignment
  if (sub === 'unassign') {
    const result = deleteAssignment('feishu', instance.appId);
    if (!result.success) return `❌ ${result.error}`;

    instance.sessions.clear();
    return `✅ 已移除绑定，将使用默认 Agent`;
  }

  // /agent assignments — list all (admin only)
  if (sub === 'assignments') {
    if (!isAdminFeishuUser(feishuUserId)) return '❌ 权限不足：该命令需要管理员权限';

    const assignments = listAssignments();
    if (assignments.length === 0) return '暂无 Agent 绑定';

    const lines = assignments.map(a => {
      const target = a.appId || a.targetId || '(渠道默认)';
      return `${a.channel}/${target} → ${a.agentDisplayName} (${a.agentName})`;
    });
    return `Agent 绑定关系:\n${lines.join('\n')}`;
  }

  // /agent <name> — switch agent (session-level)
  const agent = getAgent(sub);
  if (agent.name !== sub && sub !== 'otcclaw') {
    return `❌ 未找到 Agent: ${sub}\n使用 /agent list 查看所有可用 Agent`;
  }

  const session = getSessionForInstance(instance, feishuUserId, '');
  session.agentName = agent.name;
  session.history = [];
  return `✅ 已切换到 Agent: ${agent.displayName} (${agent.name})${agent.description ? `\n${agent.description}` : ''}`;
}

/**
 * 处理飞书消息事件（FeishuMessage 已统一为 v2 结构）
 */
async function handleEvent(instance: FeishuBotInstance, event: FeishuMessage): Promise<void> {
  const chatId = event.message.chat_id;
  const chatType = event.message.chat_type;  // "p2p" | "group"
  const messageType = event.message.message_type;
  const messageId = event.message.message_id;
  const isGroup = chatType === 'group';

  log.info(`[飞书:${instance.appName}] 收到消息: chat_id=${chatId}, chat_type=${chatType}, type=${messageType}`);

  // 群聊：只响应 @bot 的消息
  if (isGroup) {
    const mentions = event.message.mentions || [];
    const mentionedBot = instance.botOpenId
      ? mentions.some(m => m.id.open_id === instance.botOpenId)
      : mentions.length > 0;  // 未获取到 botOpenId 时，有 @mention 就响应
    if (!mentionedBot) {
      log.dim(`[飞书:${instance.appName}] 群聊消息未 @bot，忽略: ${chatId}`);
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
            const buf = await instance.api.downloadMessageResource(messageId, key);
            images.push({ data: buf.toString('base64'), mediaType: detectImageMediaType(buf) });
            log.dim(`[飞书:${instance.appName}] 下载 post 图片成功: ${key} (${buf.length} bytes)`);
          } catch (err: any) {
            log.error(`[飞书:${instance.appName}] 下载 post 图片失败: ${key} - ${err.message}`);
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
          const buf = await instance.api.downloadMessageResource(messageId, imageKey);
          images = [{
            data: buf.toString('base64'),
            mediaType: detectImageMediaType(buf),
          }];
          text = '请描述这张图片';
          log.dim(`[飞书:${instance.appName}] 下载图片成功: ${imageKey} (${buf.length} bytes)`);
        } catch (err: any) {
          log.error(`[飞书:${instance.appName}] 下载图片失败: ${err.message}`);
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

  log.dim(`[飞书:${instance.appName}] 解析结果: text="${text.slice(0, 50)}", senderId=${senderId}, group=${isGroup}`);

  // 群聊回复选项：群里以 reply 方式回复原消息
  const replyOpts = isGroup ? { messageId, isGroup: true } : undefined;

  // /debug 命令：显示用户飞书 ID（简化版，直接返回 senderId，不依赖 getUser API）
  if (text.startsWith('/debug')) {
    try {
      await sendFeishuReply(instance, chatId, `你的飞书用户 ID: ${senderId}`, replyOpts);
    } catch (err: any) {
      log.error(`[飞书:${instance.appName}] /debug 发送失败: ${err.message}`);
    }
    return;
  }

  if (!text) {
    log.dim(`[飞书:${instance.appName}] 忽略空消息或不支持的类型: ${messageType}`);
    return;
  }

  log.dim(`[飞书:${instance.appName}] ${senderName}: ${text.slice(0, 80)}`);

  try {
    // 处理内置命令
    if (text === '/start') {
      const role = isAdminFeishuUser(senderId) ? '管理员' : '普通用户';
      await sendFeishuReply(instance, chatId,
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
      const entries = getCommandEntries();
      const lines = ['📋 可用命令：', ''];
      for (const e of entries) {
        lines.push(`${e.name} — ${e.description}`);
        if (e.usage) lines.push(`  用法: ${e.usage}`);
      }
      lines.push('', '💡 也可以直接输入自然语言，AI 助手会帮你处理！');
      await sendFeishuReply(instance, chatId, lines.join('\n'), replyOpts);
      return;
    }

    if (text === '/reset') {
      resetSessionForInstance(instance, senderId);
      await sendFeishuReply(instance, chatId, '✅ 对话上下文已重置', replyOpts);
      return;
    }

    // /model 命令：查看或切换 LLM provider
    if (text.startsWith('/model')) {
      if (!isAdminFeishuUser(senderId)) {
        await sendFeishuReply(instance, chatId, '❌ 仅管理员可切换模型', replyOpts);
        return;
      }
      const arg = text.replace(/^\/model\s*/, '').trim();
      if (!arg || arg === 'list') {
        const available = getAvailableProviders();
        const current = getProviderName();
        const lines = available.map(p => `${p === current ? '▶ ' : '  '}${p}`);
        await sendFeishuReply(instance, chatId, `当前: ${current} / ${getModelName()}\n\n可用 provider:\n${lines.join('\n')}`, replyOpts);
      } else {
        const ok = switchProvider(arg as ProviderName);
        if (ok) {
          await sendFeishuReply(instance, chatId, `✅ 已切换到 ${getProviderName()} / ${getModelName()}`, replyOpts);
        } else {
          await sendFeishuReply(instance, chatId, `❌ 未知 provider: ${arg}\n可用: ${getAvailableProviders().join(', ')}`, replyOpts);
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

      const session = getSessionForInstance(instance, senderId, '');
      const agentConfig = getAgent(session.agentName);
      const prevUser = getCurrentUser();
      const prevAgent = getCurrentAgent();
      setCurrentUser(session.user);
      setCurrentAgent(agentConfig);
      let reply: string | null;
      try {
        reply = await handleCommand(instance, cmd, args, senderId);
      } finally {
        setCurrentUser(prevUser);
        setCurrentAgent(prevAgent);
      }
      if (reply !== null) {
        await sendFeishuReply(instance, chatId, reply, replyOpts);
        return;
      }
      // 未匹配的命令，fallthrough 到 AI Agent
    }

    // 自然语言 → AI Agent
    const { text: reply } = await handleAIChat(instance, chatId, text, senderId, senderName, images, replyOpts);
    if (reply) {
      await sendFeishuReply(instance, chatId, reply, replyOpts);
    }

  } catch (err: any) {
    const cause = err.cause ? ` | cause: ${err.cause.message || err.cause.code || err.cause}` : '';
    log.error(`[飞书:${instance.appName}] 处理消息出错: ${err.message}${cause}`);
    try {
      await sendFeishuReply(instance, chatId, `❌ 处理出错: ${err.message}`, replyOpts);
    } catch { /* ignore send error */ }
  }
}

/**
 * 验证飞书回调签名（暂时保留，webhook 模式可能需要）
 */
function verifySignature(appSecret: string, timestamp: string, nonce: string, signature: string, body: string): boolean {
  const signString = `${timestamp}${nonce}${body}`;
  const hmac = crypto.createHmac('sha256', appSecret);
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
      // TODO: 需要从请求中识别是哪个应用（暂时使用第一个实例）
      const instance = botInstances.values().next().value as FeishuBotInstance | undefined;
      if (instance) {
        handleEvent(instance, event).catch(err => {
          log.error(`[飞书:${instance.appName}] 处理事件出错: ${err.message}`);
        });
      }
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
      // TODO: 需要从请求中识别是哪个应用（暂时使用第一个实例）
      const instance = botInstances.values().next().value as FeishuBotInstance | undefined;
      if (!instance) return { status: 200, body: { code: 0 } };

      const mentions: FeishuMessage['message']['mentions'] =
        isGroupV1 && v1.text_without_at_bot && instance.botOpenId
          ? [{ key: '', id: { open_id: instance.botOpenId }, name: 'bot' }]
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
      handleEvent(instance, event).catch(err => {
        log.error(`[飞书:${instance.appName}] 处理事件出错: ${err.message}`);
      });
    }
    return { status: 200, body: { code: 0 } };
  }

  return { status: 200, body: { code: 0 } };
}

/**
 * 启动 WebSocket 长连接（实例级）
 */
function startWSClientForInstance(instance: FeishuBotInstance): void {
  const eventDispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.error }).register({
    'im.message.receive_v1': async (data: any) => {
      const event = data as FeishuMessage;
      handleEvent(instance, event).catch(err => {
        log.error(`[飞书:${instance.appName}] WS 处理事件出错: ${err.message}`);
      });
    },
    'im.message.message_read_v1': async () => {
      // 已读回执，无需处理
    },
  });

  // 显式禁用代理，防止 axios 读取系统/环境代理配置导致 502
  // 需要复制 SDK 默认的 response interceptor（返回 resp.data 而非整个 resp）
  const noProxyAxios = axios.create({ proxy: false });
  noProxyAxios.interceptors.response.use((resp) => resp.data);

  instance.wsClient = new Lark.WSClient({
    appId: instance.config.appId,
    appSecret: instance.config.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
    httpInstance: noProxyAxios,
  });

  instance.wsClient.start({ eventDispatcher });
  log.info(`[飞书:${instance.appName}] WebSocket 长连接已启动`);
}

/**
 * 启动 Webhook HTTP 服务器（实例级）
 */
function startWebhookForInstance(instance: FeishuBotInstance, httpPort: number): void {
  const webhookPath = '/webhook/feishu';
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
        log.error(`[飞书:${instance.appName}] HTTP 处理请求出错: ${err.message}`);
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
    log.success(`[飞书:${instance.appName}] HTTP 服务已启动: http://localhost:${httpPort}${webhookPath}`);
  });
  instance.httpServer = server;
}

/**
 * 启动单个飞书应用
 */
export async function startFeishuBot(
  appId: string,
  options?: { mode?: FeishuBotMode; httpPort?: number }
): Promise<void> {
  const mode = options?.mode ?? 'ws';

  if (botInstances.has(appId)) {
    log.warn(`[飞书:${appId}] Bot 已在运行中`);
    return;
  }

  const appConfig = loadFeishuConfig(appId);
  if (!appConfig) {
    log.warn(`[飞书] 未找到应用配置: ${appId}`);
    return;
  }

  // 解析管理员飞书用户 ID 列表（全局共享）
  const adminIdsStr = process.env.FEISHU_ADMIN_IDS || '';
  const adminIdList = adminIdsStr.split(',').map(s => s.trim()).filter(s => s);
  setAdminIds(adminIdList);

  if (adminIdList.length === 0) {
    log.warn(`[飞书:${appConfig.appName}] 未配置 FEISHU_ADMIN_IDS，所有用户将以只读身份使用`);
  } else {
    log.info(`[飞书:${appConfig.appName}] 管理员飞书 IDs: ${adminIdList.join(', ')}`);
  }

  // 创建实例
  const instance: FeishuBotInstance = {
    appId: appConfig.appId,
    appName: appConfig.appName,
    config: appConfig,
    api: new FeishuAPI(appConfig),
    wsClient: null,
    httpServer: null,
    botOpenId: '',
    cleanupTimer: null,
    sessions: new Map(),
  };

  // 验证连接
  try {
    await instance.api.getTenantAccessToken();
    log.success(`[飞书:${appConfig.appName}] API 连接成功`);
  } catch (err: any) {
    log.error(`[飞书:${appConfig.appName}] API 连接失败: ${err.message}`);
    return;
  }

  // 获取机器人自身 open_id
  try {
    const botInfo = await instance.api.getBotInfo();
    instance.botOpenId = botInfo.open_id;
    log.info(`[飞书:${appConfig.appName}] 机器人 open_id: ${instance.botOpenId} (${botInfo.app_name})`);
  } catch (err: any) {
    log.warn(`[飞书:${appConfig.appName}] 获取机器人信息失败，群聊 @mention 检测将使用宽松模式: ${err.message}`);
  }

  // 启动会话清理
  instance.cleanupTimer = setInterval(() => {
    const cleaned = cleanupSessionsForInstance(instance);
    if (cleaned > 0) log.dim(`[飞书:${appConfig.appName}] 清理了 ${cleaned} 个过期会话`);
  }, 30 * 60 * 1000);

  // 启动连接
  if (mode === 'ws') {
    startWSClientForInstance(instance);
  } else {
    startWebhookForInstance(instance, options?.httpPort ?? 3001);
  }

  botInstances.set(appId, instance);
  log.success(`[飞书:${appConfig.appName}] Bot 已启动 (模式: ${mode})`);
}

/**
 * 启动所有飞书应用
 */
export async function startAllFeishuBots(
  options?: { mode?: FeishuBotMode; httpPort?: number }
): Promise<void> {
  const configs = loadAllFeishuConfigs(true); // 只自动启动标记为 auto_start 的
  if (configs.length === 0) {
    log.warn('[飞书] 未配置需自动启动的应用，跳过启动');
    return;
  }

  for (const config of configs) {
    await startFeishuBot(config.appId, options);
  }
}

/**
 * 停止单个飞书应用
 */
export function stopFeishuBot(appId: string): void {
  const instance = botInstances.get(appId);
  if (!instance) {
    log.warn(`[飞书] 应用未运行: ${appId}`);
    return;
  }

  if (instance.wsClient) {
    instance.wsClient.close();
    instance.wsClient = null;
  }
  if (instance.httpServer) {
    instance.httpServer.close();
    instance.httpServer = null;
  }
  if (instance.cleanupTimer) {
    clearInterval(instance.cleanupTimer);
    instance.cleanupTimer = null;
  }

  botInstances.delete(appId);
  log.success(`[飞书:${instance.appName}] Bot 已停止`);
}

/**
 * 停止所有飞书应用
 */
export function stopAllFeishuBots(): void {
  for (const appId of botInstances.keys()) {
    stopFeishuBot(appId);
  }
}

/**
 * 查询 Bot 是否运行中
 */
export function isFeishuBotRunning(): boolean {
  return botInstances.size > 0;
}