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
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as Lark from '@larksuiteoapi/node-sdk';
import { FeishuAPI, type FeishuConfig, type FeishuMessage, detectFileType, isImageFile } from './api.js';
import { buildCard, buildThinkingCard } from './card.js';
import { getProvider, getModelName, switchProvider, getProviderName, getAvailableProviders, type ProviderName } from '../llm/provider.js';
import { getOrCreateUser, getUser, isAgentAdmin, type User } from '../auth/rbac.js';
import { runAgenticChat, type ImageInput, type DeliveryContext, detectImageMediaType, setCurrentAgent, getCurrentAgent } from '../llm/agent.js';
import { getAgent, resolveAgent, AgentUnboundError, type BotAppRow } from '../llm/agents/config.js';
import { runWithExecutionContext } from '../runtime/execution-context.js';
import { getDb } from '../db/connection.js';
import { log } from '../utils/logger.js';
import { getCommandEntries } from '../commands/router.js';
import { fetchSystemStatus, formatSystemStatus } from '../commands/monitor.js';
import { fetchKnowledge } from '../commands/knowledge.js';
import { getAllSkills } from '../commands/skill.js';
import { fetchMemory, saveMemory, deleteMemory, searchMemory } from '../llm/agents/memory.js';
import {
  formatKnowledge, formatSkillList,
  formatError,
} from './formatter.js';
import { saveUploadedFile } from '../commands/artifact.js';

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
  pendingNameConfirm?: boolean;
  nameAsked?: boolean;
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

type FeishuReplyOptions = {
  messageId?: string;
  isGroup?: boolean;
  updateMessageId?: string;
  traceId?: string;
};

type InteractionToolTrace = {
  round: number;
  name: string;
  inputPreview: string;
  resultPreview?: string;
  durationMs?: number;
};

type InteractionTrace = {
  id: string;
  startedAt: number;
  thoughts: string[];
  tools: InteractionToolTrace[];
};

function createTraceId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

function compactTextForLog(text: string, maxLen = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}...` : oneLine;
}

function formatValueForLog(value: unknown, maxLen = 220): string {
  try {
    return compactTextForLog(typeof value === 'string' ? value : JSON.stringify(value), maxLen);
  } catch {
    return compactTextForLog(String(value), maxLen);
  }
}

function logTraceBlock(
  instance: FeishuBotInstance,
  traceId: string,
  title: string,
  lines: Array<string | undefined>,
  level: 'info' | 'warn' | 'error' | 'dim' = 'dim',
): void {
  const details = lines.filter((line): line is string => !!line && line.trim().length > 0);
  const message = [`[飞书:${instance.appName}][${traceId}] ${title}`, ...details.map(line => `  ${line}`)].join('\n');
  log[level](message);
}

function botAppToFeishuConfig(row: BotAppRow): FeishuAppConfig {
  const cfg = JSON.parse(row.config || '{}');
  return {
    appId: row.id,
    appName: row.name,
    appSecret: row.secret,
    verificationToken: cfg.verification_token || '',
    encryptKey: cfg.encrypt_key || '',
    showThinking: row.show_thinking === 1,
  };
}

function loadFeishuConfig(appId: string): FeishuAppConfig | undefined {
  const row = getDb().prepare("SELECT * FROM bot_apps WHERE id = ? AND channel = 'feishu'").get(appId) as BotAppRow | undefined;
  if (!row) return undefined;
  return botAppToFeishuConfig(row);
}

function loadAllFeishuConfigs(onlyAutoStart = true): FeishuAppConfig[] {
  const query = onlyAutoStart
    ? "SELECT * FROM bot_apps WHERE channel = 'feishu' AND auto_start = 1"
    : "SELECT * FROM bot_apps WHERE channel = 'feishu'";
  const rows = getDb().prepare(query).all() as BotAppRow[];
  return rows.map(botAppToFeishuConfig);
}

export type FeishuBotMode = 'ws' | 'webhook';

/**
 * 同步内存中的 Bot 实例与数据库状态
 */
export async function syncFeishuBots(options?: { mode?: FeishuBotMode; httpPort?: number }): Promise<void> {
  const mode = options?.mode ?? 'ws';
  const dbApps = getDb().prepare("SELECT id as app_id, auto_start FROM bot_apps WHERE channel = 'feishu'").all() as { app_id: string; auto_start: number }[];
  
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
 * 首次创建时通过飞书联系人 API 查询真实姓名
 */
async function resolveFeishuRealName(
  instance: FeishuBotInstance,
  feishuUserId: string,
  fallback: string,
): Promise<string> {
  try {
    const userInfo = await instance.api.getUserByOpenId(feishuUserId);
    if (userInfo?.name) return userInfo.name;
  } catch (e: any) {
    log.warn(`[飞书:${instance.appName}] 查询用户信息失败，使用默认名: ${e.message}`);
  }
  return fallback;
}

function isPlaceholderName(name: string): boolean {
  return name.startsWith('user_') || name.startsWith('feishu_');
}

async function getSessionForInstance(
  instance: FeishuBotInstance,
  feishuUserId: string,
  feishuUsername: string
): Promise<FeishuSession> {
  let session = instance.sessions.get(feishuUserId);
  if (!session) {
    const agent = resolveAgent('feishu', instance.appId);
    if (!agent) throw new AgentUnboundError('feishu', instance.appId);
    const userId = `feishu_${feishuUserId}`;

    // 1) Check DB for a previously confirmed real name (survives restarts)
    const existingUser = getUser(userId);
    const dbName = existingUser?.username;
    const hasRealDbName = dbName && !isPlaceholderName(dbName);

    // 2) If DB has no real name, try the Feishu contacts API
    const username = hasRealDbName
      ? dbName
      : await resolveFeishuRealName(instance, feishuUserId, feishuUsername) || userId;

    getOrCreateUser(userId, username, 'user');
    const user: User = { id: userId, username, role: 'user' };

    const needsConfirm = isPlaceholderName(username);
    session = {
      feishuUserId,
      feishuUsername: username,
      user,
      history: [],
      lastActive: Date.now(),
      agentName: agent.name,
      pendingNameConfirm: needsConfirm,
      nameAsked: false,
    };
    instance.sessions.set(feishuUserId, session);
  } else {
    // Session exists but username may be stale (e.g. initial API call failed).
    // Re-resolve via API when the stored name is still a placeholder.
    const cur = session.user.username;
    if (isPlaceholderName(cur)) {
      const realName = await resolveFeishuRealName(instance, feishuUserId, cur);
      if (realName !== cur) {
        session.user.username = realName;
        session.feishuUsername = realName;
        session.pendingNameConfirm = false;
        session.nameAsked = false;
        getOrCreateUser(session.user.id, realName, session.user.role);
      }
    }
  }
  session.lastActive = Date.now();
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
    if (agent) session.agentName = agent.name;
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
  replyOpts?: FeishuReplyOptions,
): Promise<{ text: string; mediaPaths?: string[] }> {
  const session = await getSessionForInstance(instance, feishuUserId, feishuUsername);

  return runWithExecutionContext({ channel: 'feishu', user: session.user }, async () => {
  const showThinkingEnabled = instance.config.showThinking !== false;
  const traceId = replyOpts?.traceId ?? createTraceId();
  const interactionTrace: InteractionTrace = {
    id: traceId,
    startedAt: Date.now(),
    thoughts: [],
    tools: [],
  };

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

  const agentConfig = getAgent(session.agentName);
  logTraceBlock(instance, traceId, 'AI 对话开始', [
    `user=${session.user.username} (${session.user.role})`,
    `agent=${agentConfig.displayName} (${agentConfig.name})`,
    `history=${session.history.length} 条`,
    `input=${compactTextForLog(userInput, 240)}`,
    images?.length ? `images=${images.length}` : undefined,
  ], 'info');

  // 渐进发送过程卡片（节流 1.5s）
  let lastUpdateTime = 0;
  const THROTTLE_MS = 1500;
  const onProgress = (event: import('../llm/agent.js').ProgressEvent) => {
    if (event.type === 'thinking') {
      const preview = compactTextForLog(event.text, 220);
      if (preview) interactionTrace.thoughts.push(`r${event.round}: ${preview}`);
    } else if (event.type === 'tool_start') {
      interactionTrace.tools.push({
        round: event.round,
        name: event.name,
        inputPreview: formatValueForLog(event.input),
      });
    } else if (event.type === 'tool_end') {
      const toolTrace = [...interactionTrace.tools].reverse().find(
        item => item.name === event.name && item.round === event.round && item.resultPreview === undefined,
      );
      if (toolTrace) {
        toolTrace.resultPreview = formatValueForLog(event.result, 260);
        toolTrace.durationMs = event.durationMs;
      }
    }

    if (!showThinkingEnabled) return;

    const now = Date.now();
    if (now - lastUpdateTime < THROTTLE_MS) return;
    lastUpdateTime = now;
    let hint = '';
    if (event.type === 'tool_start') hint = `🔧 正在调用 ${event.name}...`;
    else if (event.type === 'thinking') hint = `💭 ${event.text.slice(0, 80)}`;
    if (hint) {
      void sendProgressCard(hint);
    }
  };

  let textReply = await runAgenticChat(session.history, userInput, session.user, {
    streamEnabled: false,
    logPrefix: `[飞书:${instance.appName}][${traceId}][${session.user.username}] `,
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

  if (textReply) {
    session.history.push({ role: 'assistant', content: textReply });
  }

  const { cleanText, mediaPaths } = extractMediaFromText(textReply);
  let processedText = cleanText ? await processImagesInText(instance, cleanText) : '';

  const elapsedMs = Date.now() - interactionTrace.startedAt;
  const toolLines = interactionTrace.tools.slice(0, 8).map((tool, index) =>
    `tool${index + 1}=r${tool.round} ${tool.name}${tool.durationMs !== undefined ? ` (${tool.durationMs}ms)` : ''} | input=${tool.inputPreview}${tool.resultPreview ? ` | result=${tool.resultPreview}` : ''}`
  );
  const thoughtLines = interactionTrace.thoughts.slice(0, 6).map((thought, index) => `thought${index + 1}=${thought}`);
  logTraceBlock(instance, traceId, 'AI 对话完成', [
    `elapsed=${elapsedMs}ms`,
    `reply=${compactTextForLog(processedText || '（无回复内容）', 320)}`,
    mediaPaths.length > 0 ? `media=${mediaPaths.map(p => path.basename(p)).join(', ')}` : undefined,
    `tools=${interactionTrace.tools.length}`,
    ...toolLines,
    interactionTrace.tools.length > toolLines.length ? `tools_more=${interactionTrace.tools.length - toolLines.length}` : undefined,
    `thoughts=${interactionTrace.thoughts.length}`,
    ...thoughtLines,
    interactionTrace.thoughts.length > thoughtLines.length ? `thoughts_more=${interactionTrace.thoughts.length - thoughtLines.length}` : undefined,
  ], 'info');

  if (processedText && progressMessageId) {
    try {
      const finalReplyId = await sendFeishuReply(instance, chatId, processedText, {
        ...replyOpts,
        updateMessageId: progressMessageId
      });
      if (finalReplyId === progressMessageId) {
        if (mediaPaths.length > 0) {
          await sendMediaMessages(instance, chatId, mediaPaths, replyOpts);
        }
        return { text: '' };
      }
    } catch (err: any) {
      log.warn(`[飞书:${instance.appName}] 尝试通过进度卡片返回最终结果失败: ${err.message}`);
    }
  }

  return { text: processedText || '（无回复内容）', mediaPaths };
  }); // end runWithExecutionContext
}

/**
 * 从 LLM 回复中提取独立的媒体文件路径（图片和文件）
 * 返回清理后的文本和提取的媒体路径列表
 */
const PROJECT_ROOT = process.cwd();
const MEDIA_EXT_PATTERN = '(?:png|jpe?g|gif|webp|bmp|ico|tiff|pdf|docx?|xlsx?|csv|pptx?|mp4|mov|avi|opus|ogg|txt|md|json|ya?ml|log)';
const MEDIA_EXTS = new RegExp(`\\.${MEDIA_EXT_PATTERN}$`, 'i');
const BARE_MEDIA_PATH_RE = new RegExp(`(?:^|\\s)((?:\\/|\\.\\/|~\\/)[^\\s"'()\\]\\{\\}]+?\\.${MEDIA_EXT_PATTERN})\\b`, 'giu');
const RELATIVE_MEDIA_SEGMENT_PATTERN = String.raw`[^\s"'()\[\]\{\}/\\]+`;
const RELATIVE_MEDIA_PATH_RE = new RegExp(`(?:^|[\\s"'(\`])((?:${RELATIVE_MEDIA_SEGMENT_PATTERN}\\/)*${RELATIVE_MEDIA_SEGMENT_PATTERN}\\.${MEDIA_EXT_PATTERN})\\b`, 'giu');
const LABELED_MEDIA_PATH_RE = new RegExp(`(?:^|[\\s{,(])(?:"|')?(?:path|file|filepath|file_path|文件)(?:"|')?\\s*[:=]\\s*(?:"|')([^"'\\n]+?\\.${MEDIA_EXT_PATTERN})(?:"|')`, 'giu');

type MediaMatch = {
  rawPath: string;
  start: number;
  end: number;
};

function resolveMediaPath(rawPath: string): string {
  if (rawPath.startsWith('~/')) {
    return path.join(process.env.HOME || '', rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) {
    return path.normalize(rawPath);
  }
  return path.resolve(PROJECT_ROOT, rawPath);
}

function isMarkdownImagePath(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 4), start);
  return before.includes('](');
}

function addMediaMatches(matches: MediaMatch[], text: string, regex: RegExp): void {
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    const rawPath = match[1];
    if (!rawPath) continue;
    const fullMatch = match[0] || '';
    const offsetInFull = fullMatch.lastIndexOf(rawPath);
    const start = (match.index ?? 0) + Math.max(offsetInFull, 0);
    matches.push({ rawPath, start, end: start + rawPath.length });
  }
}

function removeRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return text.trim();

  const merged = ranges
    .sort((a, b) => a.start - b.start)
    .reduce<Array<{ start: number; end: number }>>((acc, range) => {
      const prev = acc[acc.length - 1];
      if (!prev || range.start > prev.end) {
        acc.push({ ...range });
      } else {
        prev.end = Math.max(prev.end, range.end);
      }
      return acc;
    }, []);

  let result = '';
  let cursor = 0;
  for (const range of merged) {
    result += text.slice(cursor, range.start);
    cursor = range.end;
  }
  result += text.slice(cursor);

  return result
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractMediaFromText(text: string): { cleanText: string; mediaPaths: string[] } {
  if (!text) return { cleanText: text, mediaPaths: [] };

  const matches: MediaMatch[] = [];
  addMediaMatches(matches, text, LABELED_MEDIA_PATH_RE);
  addMediaMatches(matches, text, BARE_MEDIA_PATH_RE);
  addMediaMatches(matches, text, RELATIVE_MEDIA_PATH_RE);

  const mediaPaths: string[] = [];
  const removalRanges: Array<{ start: number; end: number }> = [];
  const seenResolved = new Set<string>();

  for (const match of matches) {
    if (!MEDIA_EXTS.test(match.rawPath)) continue;
    if (isImageFile(match.rawPath) && isMarkdownImagePath(text, match.start)) continue;

    const resolved = resolveMediaPath(match.rawPath);
    if (!fs.existsSync(resolved)) continue;
    if (seenResolved.has(resolved)) continue;

    seenResolved.add(resolved);
    mediaPaths.push(resolved);
    removalRanges.push({ start: match.start, end: match.end });
  }

  return { cleanText: removeRanges(text, removalRanges), mediaPaths };
}

/**
 * 上传并发送媒体文件（图片或文件），支持私聊和群聊
 */
async function sendMediaMessages(
  instance: FeishuBotInstance,
  chatId: string,
  mediaPaths: string[],
  replyOpts?: FeishuReplyOptions,
): Promise<void> {
  const useReply = replyOpts?.isGroup && replyOpts?.messageId;
  const traceTag = replyOpts?.traceId ? `[${replyOpts.traceId}] ` : '';

  for (const rawPath of mediaPaths) {
    const resolved = resolveMediaPath(rawPath);

    if (!fs.existsSync(resolved)) {
      log.warn(`[飞书:${instance.appName}] ${traceTag}媒体文件不存在，跳过: ${resolved}`);
      continue;
    }

    const fileName = path.basename(resolved);

    try {
      if (isImageFile(fileName)) {
        const imageKey = await instance.api.uploadImage(resolved);
        if (!imageKey) continue;
        if (useReply) {
          await instance.api.replyImage(replyOpts!.messageId!, imageKey);
        } else {
          await instance.api.sendImage(chatId, imageKey);
        }
        log.dim(`[飞书:${instance.appName}] ${traceTag}实际已发送图片: ${fileName}`);
      } else {
        const fileType = detectFileType(fileName);
        const fileKey = await instance.api.uploadFile(resolved, fileName, fileType);
        if (!fileKey) continue;
        if (useReply) {
          await instance.api.replyFile(replyOpts!.messageId!, fileKey);
        } else {
          await instance.api.sendFile(chatId, fileKey);
        }
        log.dim(`[飞书:${instance.appName}] ${traceTag}实际已发送文件: ${fileName}`);
      }
    } catch (err: any) {
      log.error(`[飞书:${instance.appName}] ${traceTag}发送媒体失败 (${fileName}): ${err.message}`);
    }
  }
}

/**
 * 扫描文本中的图片路径（本地或 URL），上传到飞书并替换为 ![image](image_key)
 * 上传失败时移除该图片引用，避免将无效路径作为 image_key 发送给飞书
 */
async function processImagesInText(instance: FeishuBotInstance, text: string): Promise<string> {
  if (!text) return text;

  let result = text;

  // 第一步：处理 Markdown 图片语法 ![alt](path.ext)
  // 跳过已经是合法飞书 key 的（img_v2_xxx 格式）
  const MD_IMG_RE = /!\[([^\]]*)\]\(([^)]+\.(?:png|jpe?g|gif|webp))\)/gi;
  const mdMatches = [...text.matchAll(MD_IMG_RE)];

  for (const m of mdMatches) {
    const fullMatch = m[0];
    const filePath = m[2];
    if (/^img_[a-zA-Z0-9_-]+$/.test(filePath)) continue; // 已是合法 key，跳过
    try {
      log.dim(`[飞书:${instance.appName}] 检测到 Markdown 图片: ${filePath}，正在上传...`);
      const imageKey = await instance.api.uploadImage(filePath);
      if (imageKey) {
        result = result.split(fullMatch).join(`![image](${imageKey})`);
      } else {
        result = result.split(fullMatch).join(''); // 上传失败，移除引用
      }
    } catch (err: any) {
      log.warn(`[飞书:${instance.appName}] 上传图片 ${filePath} 失败: ${err.message}`);
      result = result.split(fullMatch).join(''); // 移除引用，避免无效 key 进入卡片
    }
  }

  // 第二步：处理裸路径（/path/to/img.png 或 https://...）
  const IMAGE_RE = /(?:^|\s)((?:\/|\.\/|~\/|https?:\/\/)\S+\.(?:png|jpe?g|gif|webp))\b/gi;
  const matches = [...result.matchAll(IMAGE_RE)];

  for (const m of matches) {
    const filePath = m[1];
    try {
      log.dim(`[飞书:${instance.appName}] 检测到图片路径: ${filePath}，正在上传...`);
      const imageKey = await instance.api.uploadImage(filePath);
      if (imageKey) {
        result = result.split(filePath).join(imageKey);
      }
    } catch (err: any) {
      log.warn(`[飞书:${instance.appName}] 上传图片 ${filePath} 失败: ${err.message}`);
    }
  }

  // 第三步：补全 Markdown 格式：img_v2_... -> ![image](img_v2_...)
  const KEY_RE = /(img_v2_[a-zA-Z0-9-]+)/g;
  result = result.replace(KEY_RE, (key, offset) => {
    const before = result.slice(Math.max(0, offset - 2), offset);
    if (before === '](') return key;
    return `![image](${key})`;
  });

  return result;
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
  options?: FeishuReplyOptions,
): Promise<string> {
  const MAX_LEN = 4000;
  const traceTag = options?.traceId ? `[${options.traceId}] ` : '';
  const mode = options?.updateMessageId ? 'update' : (options?.isGroup && options?.messageId ? 'reply' : 'send');
  log.dim(`[飞书:${instance.appName}] ${traceTag}准备发送回复: mode=${mode}, len=${text?.length ?? 0}, preview=${compactTextForLog(text || '（无回复内容）', 220)}`);

  // 更新已有卡片模式
  if (options?.updateMessageId) {
    try {
      const card = buildCard(text.length > MAX_LEN ? text.slice(-MAX_LEN) : text);
      await instance.api.updateCard(options.updateMessageId, card);
      return options.updateMessageId;
    } catch (err: any) {
      log.warn(`[飞书:${instance.appName}] ${traceTag}更新卡片失败，回退到发新消息: ${err.message}`);
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
      log.error(`[飞书:${instance.appName}] ${traceTag}Card 分片 ${i + 1}/${chunks.length} 发送失败: ${errorDetail}，回退到纯文本`);
      try {
        if (useReply) {
          lastMessageId = await instance.api.replyMessage(options.messageId!, 'text', { text: chunkText });
        } else {
          lastMessageId = await instance.api.sendText(chatId, chunkText);
        }
      } catch (e: any) {
         log.error(`[飞书:${instance.appName}] ${traceTag}纯文本降级发送依然失败: ${e.message}`);
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
    case 'faq': {
      const items = fetchKnowledge(args || undefined, getCurrentAgent()?.id);
      return formatKnowledge(items);
    }
    case 'skill': {
      const sub = args.split(/\s+/)[0]?.toLowerCase();
      if (!sub || sub === 'list') {
        const session = await getSessionForInstance(instance, feishuUserId, '');
        const agentId = getAgent(session.agentName).id;
        const skills = getAllSkills(agentId);
        return formatSkillList(skills);
      }
      return null;
    }
    case 'agent': {
      return handleAgentCommand(instance, args, feishuUserId);
    }
    case 'memory': {
      return handleMemoryCommand(args, instance, feishuUserId);
    }
    default:
      return null;
  }
}

async function handleMemoryCommand(args: string, instance: FeishuBotInstance, feishuUserId: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || 'list').toLowerCase();
  const rest = parts.slice(1).join(' ');

  const session = await getSessionForInstance(instance, feishuUserId, '');
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
    if (!rest) return '用法: /memory add <内容>';
    const result = saveMemory({ content: rest, scope: 'agent', agentId, source: 'manual' });
    if (!result.success) return `❌ ${(result as any).error}`;
    return `✅ 记忆已保存: ${rest}`;
  }

  if (sub === 'del' || sub === 'delete') {
    if (!rest) return '用法: /memory del <id>';
    const result = deleteMemory(rest);
    if (!result.success) return `❌ ${(result as any).error}`;
    return `✅ 记忆已删除: ${rest}`;
  }

  return 'Memory 用法：\n/memory list\n/memory add <内容>\n/memory search <关键词>\n/memory del <id>';
}

async function handleAgentCommand(instance: FeishuBotInstance, args: string, feishuUserId: string): Promise<string> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();

  // /agent — show current agent
  if (!sub) {
    const session = await getSessionForInstance(instance, feishuUserId, '');
    const agent = getAgent(session.agentName);
    return `当前 Agent: ${agent.displayName} (${agent.name})\n${agent.description || ''}`;
  }

  return '❌ `/agent` 的 list/switch/assign 等管理操作仅支持 CLI channel';
}

/**
 * 处理飞书消息事件（FeishuMessage 已统一为 v2 结构）
 */
async function handleEvent(instance: FeishuBotInstance, event: FeishuMessage): Promise<void> {
  return runWithExecutionContext({ channel: 'feishu' }, async () => {
  const chatId = event.message.chat_id;
  const chatType = event.message.chat_type;  // "p2p" | "group"
  const messageType = event.message.message_type;
  const messageId = event.message.message_id;
  const isGroup = chatType === 'group';
  const traceId = createTraceId();

  // 群聊：只响应 @bot 的消息
  if (isGroup) {
    const mentions = event.message.mentions || [];
    const mentionedBot = instance.botOpenId
      ? mentions.some(m => m.id.open_id === instance.botOpenId)
      : mentions.length > 0;  // 未获取到 botOpenId 时，有 @mention 就响应
    if (!mentionedBot) {
      logTraceBlock(instance, traceId, '忽略群聊消息', [
        `chat=${chatType}:${chatId}`,
        `message=${messageType}/${messageId}`,
        'reason=群聊消息未 @bot',
      ]);
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
    } else if (messageType === 'file') {
      const fileKey = content.file_key;
      const fileName = content.file_name || '未知文件';
      if (fileKey) {
        try {
          const buf = await instance.api.downloadMessageResource(messageId, fileKey, 'file');
          const savedPath = saveUploadedFile(buf, fileName);
          text = `用户发送了文件 "${fileName}" (${buf.length} bytes)，已保存到本地路径: ${savedPath}\n请使用合适的工具（parse_word、parse_excel、read_file 等）读取文件内容。`;
          log.dim(`[飞书:${instance.appName}] 下载文件成功: ${fileName} (${buf.length} bytes) -> ${savedPath}`);
        } catch (err: any) {
          log.error(`[飞书:${instance.appName}] 下载文件失败: ${err.message}`);
          text = `用户发送了文件 "${fileName}"，但下载失败。`;
        }
      }
    } else if (messageType === 'audio') {
      text = '';
    } else {
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
  const replyOpts: FeishuReplyOptions = isGroup ? { messageId, isGroup: true, traceId } : { traceId };

  logTraceBlock(instance, traceId, '收到消息', [
    `chat=${chatType}:${chatId}`,
    `message=${messageType}/${messageId}`,
    `sender=${senderName} (${senderId})`,
    `group=${isGroup}`,
    `text=${compactTextForLog(text || '（空）', 240)}`,
    images?.length ? `images=${images.length}` : undefined,
  ], 'info');

  // /debug 命令：显示用户飞书 ID（简化版，直接返回 senderId，不依赖 getUser API）
  if (text.startsWith('/debug')) {
    try {
      await sendFeishuReply(instance, chatId, `你的飞书用户 ID: ${senderId}`, replyOpts);
    } catch (err: any) {
      log.error(`[飞书:${instance.appName}] /debug 发送失败: ${err.message}`);
    }
    return;
  }

  // 对不支持的消息类型给出友好提示
  if (!text && (messageType === 'audio' || messageType === 'media')) {
    const hint = messageType === 'audio'
      ? '暂不支持语音消息，请发送文字或图片。'
      : '暂不支持该类型的消息，请发送文字、图片或文件。';
    try {
      await sendFeishuReply(instance, chatId, hint, replyOpts);
    } catch { /* ignore */ }
    return;
  }

  if (!text) {
    logTraceBlock(instance, traceId, '忽略消息', [`reason=空消息或不支持的类型 (${messageType})`]);
    return;
  }

  // --- 身份确认流程：API 未能获取用户真实姓名时，友好询问 ---
  if (!text.startsWith('/')) {
    const nameSession = await getSessionForInstance(instance, senderId, senderName);
    if (nameSession.pendingNameConfirm) {
      if (!nameSession.nameAsked) {
        // 首次交互：先回答用户问题之前，礼貌地询问身份
        await sendFeishuReply(instance, chatId,
          '你好！我还不知道你的名字，请先告诉我你怎么称呼，方便我更好地为你服务。',
          replyOpts);
        nameSession.nameAsked = true;
        return;
      }
      // 用户回复了名字
      const name = text.trim();
      if (name.length > 0 && name.length <= 30) {
        nameSession.user.username = name;
        nameSession.feishuUsername = name;
        nameSession.pendingNameConfirm = false;
        nameSession.nameAsked = false;
        getOrCreateUser(nameSession.user.id, name, nameSession.user.role);
        log.info(`[飞书:${instance.appName}] 用户 ${senderId} 确认姓名: ${name}`);
        await sendFeishuReply(instance, chatId,
          `好的，${name}！有什么我可以帮你的吗？`,
          replyOpts);
        return;
      }
      // Name too long or empty — re-ask
      await sendFeishuReply(instance, chatId,
        '名字似乎不太对，请输入你的真实姓名（30字以内）。',
        replyOpts);
      return;
    }
  }

  try {
    // 处理内置命令
    if (text === '/start') {
      const startSession = await getSessionForInstance(instance, senderId, '');
      const startAgentId = getAgent(startSession.agentName).id;
      const role = isAgentAdmin(startAgentId) ? 'agent admin' : 'member';
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
      const modelSession = await getSessionForInstance(instance, senderId, '');
      if (!isAgentAdmin(getAgent(modelSession.agentName).id)) {
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

      const session = await getSessionForInstance(instance, senderId, '');
      const agentConfig = getAgent(session.agentName);
      const prevAgent = getCurrentAgent();
      setCurrentAgent(agentConfig);
      let reply: string | null;
      try {
        reply = await runWithExecutionContext(
          { channel: 'feishu', user: session.user },
          () => handleCommand(instance, cmd, args, senderId),
        );
      } finally {
        setCurrentAgent(prevAgent);
      }
      if (reply !== null) {
        logTraceBlock(instance, traceId, '命令回复', [
          `cmd=/${cmd}`,
          `reply=${compactTextForLog(reply, 260)}`,
        ]);
        await sendFeishuReply(instance, chatId, reply, replyOpts);
        return;
      }
      // 未匹配的命令，fallthrough 到 AI Agent
    }

    // 自然语言 → AI Agent
    const { text: reply, mediaPaths } = await handleAIChat(instance, chatId, text, senderId, senderName, images, replyOpts);
    if (reply) {
      await sendFeishuReply(instance, chatId, reply, replyOpts);
    }
    // 文本之后发送独立媒体附件（图片/文件）
    if (mediaPaths && mediaPaths.length > 0) {
      await sendMediaMessages(instance, chatId, mediaPaths, replyOpts);
    }

  } catch (err: any) {
    if (err instanceof AgentUnboundError) {
      log.warn(`[飞书:${instance.appName}][${traceId}] ${err.message}`);
      try { await sendFeishuReply(instance, chatId, `⚠️ ${err.message}`, replyOpts); } catch { /* ignore */ }
      return;
    }
    const cause = err.cause ? ` | cause: ${err.cause.message || err.cause.code || err.cause}` : '';
    log.error(`[飞书:${instance.appName}][${traceId}] 处理消息出错: ${err.message}${cause}`);
    try {
      await sendFeishuReply(instance, chatId, `❌ 处理出错: ${err.message}`, replyOpts);
    } catch { /* ignore send error */ }
  }
  }); // end runWithExecutionContext
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