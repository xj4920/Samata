import Anthropic from '@anthropic-ai/sdk';
import { getProvider, getProviderName, getProviderByName, getModelName, type CreateMessageParams, type CreateMessageResult } from './provider.js';
import { getCurrentUser, type User } from '../auth/rbac.js';
import type { AgentConfig } from './agents/config.js';
import { getAgentTools, getDefaultAgent, getCurrentAgent, setCurrentAgent, type DeliveryContext, type ToolContext } from './agents/config.js';
import { buildSystemPrompt } from './agents/prompt.js';
import { isPendingReload, setPendingReload } from './reload.js';
import { getAllNativeTools, executeNativeTool } from '../tools/index.js';
import { getMcpTools, callMcpTool } from '../services/mcp-manager.js';
import { log } from '../utils/logger.js';
import { throwIfAborted } from '../utils/abort.js';
import { renderMarkdown } from '../utils/markdown.js';
import * as fs from 'fs';
import * as path from 'path';

// Re-export shared types so existing import paths keep working
export type { DeliveryContext, ToolContext };
export { getCurrentAgent, setCurrentAgent };

const showThinking = () => process.env.SHOW_THINKING !== 'false';

/** 图片输入（base64 编码） */
export interface ImageInput {
  data: string;  // base64 encoded image data (no data URI prefix)
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

/** 从 Buffer magic bytes 检测图片 MIME 类型 */
export function detectImageMediaType(buf: Buffer): ImageInput['mediaType'] {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/png'; // fallback
}

export async function executeTool(name: string, input: any, deliveryContext?: DeliveryContext): Promise<string> {
  const globalTools = getGlobalTools();
  const ctx: ToolContext = { deliveryContext, globalTools };
  if (name.startsWith('mcp_')) {
    return callMcpTool(name, input);
  }
  return executeNativeTool(name, input, ctx);
}

// --- History management ---

const MAX_HISTORY_MESSAGES = 80;

function isToolResultMessage(msg: Anthropic.MessageParam): boolean {
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as any[]).some(b => b.type === 'tool_result');
}

/**
 * Safely trim history from the front, ensuring tool_use/tool_result pairs stay intact.
 * The cut point always lands on a plain 'user' message (not a tool_result follow-up).
 */
function trimHistory(history: Anthropic.MessageParam[], maxLen: number = MAX_HISTORY_MESSAGES): void {
  if (history.length <= maxLen) return;
  let cutIndex = history.length - maxLen;
  while (cutIndex < history.length) {
    const msg = history[cutIndex];
    if (msg.role === 'user' && !isToolResultMessage(msg)) break;
    cutIndex++;
  }
  if (cutIndex > 0 && cutIndex < history.length) {
    history.splice(0, cutIndex);
  }
}

// --- Conversation state ---
let conversationHistory: Anthropic.MessageParam[] = [];

/** All globally registered tools (native + connected MCP servers) */
export function getGlobalTools(): Anthropic.Tool[] {
  return [...getAllNativeTools(), ...getMcpTools()];
}

/** @deprecated Use getGlobalTools() + getAgentTools() instead */
export function getTools(): Anthropic.Tool[] {
  return getGlobalTools();
}

export function getSystemPrompt(user?: User): string {
  const u = user ?? getCurrentUser();
  return `你是 Samata，意为"平等，技术平权"。你可以：
1. 查询和管理客户信息（客户状态流转：Initial Contact ↔ Requirement Discussion ↔ Solution Design ↔ UAT ↔ PROD，支持 advance 推进和 rollback 回退）
2. 查询交易成交数据 — 支持按管理人名称(client)查询，会自动展开为其下所有交易对手
3. 回答关于客户的问题，提供数据分析
4. 提供展业建议和话术参考
5. 搜索知识库回答常见问题
5. 工具自举：你可以根据实际需要创建新的 skill、修改项目源代码，修改源码文件（.ts/.js/.json）后会自动热重载。
   - 使用 save_skill 创建可复用的提示词模板
   - 修改已有文件优先使用 edit_file（搜索替换），新建文件使用 write_file
   - 修改代码前请先用 read_file 了解现有代码结构

当前用户：${u.username}，角色：${u.role}。${u.role === 'user' ? '当前为普通用户，不可执行写操作（添加、更新、删除、推进状态）。' : '当前为管理员，可执行所有操作。'}

回答要求：
- 用简洁专业的中文回答
- 查询数据时主动使用工具获取最新信息，不要凭记忆回答
- 给出展业建议时结合客户的实际状态和需求

工具使用规范：
- 使用 query_clients 工具时，必须从用户问题中提取关键词并传入keyword参数
  * 用户问"极速客户" → keyword="极速"
  * 用户问"VIP客户" → keyword="VIP"
  * 用户问"常速客户" → keyword="常速"
  * 用户问"某某公司" → keyword="某某"
  * 只有用户明确说"所有客户"或"全部客户"时才可以不传keyword
- 禁止使用空参数{}查询 query_clients，这会返回全量数据，效率低且可能超出限制`;
}

/**
 * Strip <think> blocks from model output.
 * When showThinking is true, extracted thoughts are printed via log.dim().
 */
function stripThinkBlocks(text: string, showThinkingOpt: boolean): string {
  if (showThinkingOpt) {
    for (const m of text.matchAll(/<think>([\s\S]*?)<\/think>/g)) {
      const thought = m[1].trim();
      if (thought) log.dim(`💭 ${thought}`);
    }
  }
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * 调用 LLM，优先使用流式输出（CLI 逐字显示），回退到非流式
 * 返回 { result, streamed } — streamed 表示文本已经输出到 stdout
 */
async function callLLM(params: CreateMessageParams, streamText: boolean, showThinkingOpt: boolean = false, providerOverride?: import('./provider.js').LLMProvider): Promise<{ result: CreateMessageResult; streamed: boolean }> {
  const provider = providerOverride ?? getProvider();

  if (streamText && provider.createMessageStream) {
    try {
      let result: CreateMessageResult | null = null;
      let buffer = '';
      for await (const event of provider.createMessageStream(params)) {
        throwIfAborted();
        if (event.type === 'text_delta') {
          buffer += event.text;
        } else if (event.type === 'done') {
          result = { content: event.content, stop_reason: event.stop_reason };
        }
      }
      if (buffer) {
        const clean = stripThinkBlocks(buffer, showThinkingOpt);
        if (clean) {
          log.print();
          const rendered = renderMarkdown(clean);
          process.stdout.write(rendered.trimEnd() + '\n');
        }
      }
      if (!result) throw new Error('Stream ended without done event');
      return { result, streamed: !!buffer };
    } catch (err: any) {
      log.dim(`流式请求失败 (${err.message})，回退到非流式...`);
    }
  }

  throwIfAborted();
  return { result: await provider.createMessage(params), streamed: false };
}

export type ProgressEvent =
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string }
  | { type: 'thinking'; text: string };

/**
 * 通用的 agentic chat 函数，支持 CLI 和飞书bot复用
 * @param history 消息历史数组（会被修改）
 * @param userInput 用户输入
 * @param user 当前用户（用于生成 system prompt）
 * @param options 配置选项
 * @returns 最终的文本回复
 */
export async function runAgenticChat(
  history: Anthropic.MessageParam[],
  userInput: string,
  user: User,
  options: {
    streamEnabled?: boolean;
    logPrefix?: string;
    showThinking?: boolean;
    agentConfig?: AgentConfig;
    images?: ImageInput[];
    onProgress?: (event: ProgressEvent) => void;
    deliveryContext?: DeliveryContext;
  } = {}
): Promise<string> {
  const { streamEnabled = false, logPrefix = '', showThinking: showThinkingOpt = showThinking(), agentConfig, images, onProgress, deliveryContext } = options;

  const agent = agentConfig;
  const maxHistory = agent?.maxHistory ?? MAX_HISTORY_MESSAGES;
  const allTools = getGlobalTools();
  const activeTools = agent ? getAgentTools(agent, allTools) : allTools;
  const systemPrompt = agent ? buildSystemPrompt(agent, user) : getSystemPrompt(user);

  // 图片处理：非 anthropic provider 主动切换到 anthropic（其他 provider 不支持 vision）
  let visionProvider: import('./provider.js').LLMProvider | undefined;
  let visionModel: string | undefined;
  if (images && images.length > 0 && getProviderName() !== 'anthropic') {
    const anthropic = getProviderByName('anthropic');
    if (anthropic) {
      visionProvider = anthropic;
      visionModel = anthropic.defaultModel;
      log.dim(`${logPrefix}📷 图片消息，切换到 anthropic/${visionModel} 处理`);
    } else {
      log.warn(`${logPrefix}⚠️ 当前 provider 不支持图片，且无可用 anthropic provider`);
    }
  }

  trimHistory(history, maxHistory);

  const historyLenBefore = history.length;

  // 构建 user message：如果有图片则使用 content block 数组
  if (images && images.length > 0) {
    const contentBlocks: Anthropic.MessageParam['content'] = [];
    for (const img of images) {
      (contentBlocks as any[]).push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      });
    }
    if (userInput) {
      (contentBlocks as any[]).push({ type: 'text', text: userInput });
    }
    history.push({ role: 'user', content: contentBlocks });
  } else {
    history.push({ role: 'user', content: userInput });
  }

  const makeParams = (): CreateMessageParams => ({
    model: visionModel ?? agent?.model ?? getModelName(),
    max_tokens: 4096,
    system: systemPrompt,
    tools: activeTools,
    messages: history,
  });

  let response: CreateMessageResult;
  let streamed: boolean;
  try {
    ({ result: response, streamed } = await callLLM(makeParams(), streamEnabled, showThinkingOpt, visionProvider));
  } catch (err: any) {
    log.error(`${logPrefix}AI 请求失败: ${err?.message ?? String(err)}`);
    history.length = historyLenBefore;
    throw err;
  }

  // Agentic loop: keep processing until no more tool calls
  while (response.stop_reason === 'tool_use') {
    throwIfAborted();
    const assistantContent = response.content;
    history.push({ role: 'assistant', content: assistantContent });

    if (!streamed && showThinkingOpt) {
      for (const block of assistantContent) {
        if (block.type === 'text' && block.text) {
          log.dim(`${logPrefix}💭 ${block.text}`);
          onProgress?.({ type: 'thinking', text: block.text });
        }
      }
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        if (showThinkingOpt) {
          log.dim(`${logPrefix}🔧 调用工具: ${block.name}`);
          log.dim(`${logPrefix}   参数: ${JSON.stringify(block.input)}`);
        }
        onProgress?.({ type: 'tool_start', name: block.name });
        throwIfAborted();
        let result: string;
        try {
          result = await executeTool(block.name, block.input, deliveryContext);
        } catch (err: any) {
          result = JSON.stringify({ error: `工具执行异常: ${err.message}` });
        }
        onProgress?.({ type: 'tool_end', name: block.name });
        if (showThinkingOpt) {
          const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
          log.dim(`${logPrefix}   结果: ${preview}`);
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    history.push({ role: 'user', content: toolResults });

    try {
      ({ result: response, streamed } = await callLLM(makeParams(), streamEnabled, showThinkingOpt, visionProvider));
    } catch (err: any) {
      log.error(`${logPrefix}AI 请求失败: ${err?.message ?? String(err)}`);
      history.length = historyLenBefore;
      throw err;
    }
  }

  const assistantContent = response.content;
  history.push({ role: 'assistant', content: assistantContent });

  // 提取文本回复
  let textReply = '';
  for (const block of assistantContent) {
    if (block.type === 'text') {
      textReply += block.text;
    }
  }

  // 非流式回退时，文本未在 callLLM 中输出，这里兜底渲染
  if (!streamed && textReply) {
    const clean = stripThinkBlocks(textReply, showThinkingOpt);
    if (clean) {
      log.print();
      const rendered = renderMarkdown(clean);
      process.stdout.write(rendered.trimEnd() + '\n');
    }
  }

  // 延迟执行 reload：等 agentic loop 结束、回复渲染完毕后再重启
  if (isPendingReload()) {
    setPendingReload(false);
    log.info('🔄 即将重载应用...');
    setTimeout(async () => {
      const { gracefulShutdown } = await import('../index.js');
      gracefulShutdown();
      process.exit(120);
    }, 500);
  }

  return textReply;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;
const IMAGE_PATH_RE = /(?:^|\s)((?:\/|\.\/|~\/)\S+\.(?:png|jpe?g|gif|webp))\b/gi;

/**
 * 从用户输入中提取本地图片路径，返回 images 数组。
 * 保留原始路径在文本中（供 archive_health_file 等工具使用）。
 */
function extractLocalImages(input: string): { text: string; images: ImageInput[] } {
  const images: ImageInput[] = [];
  // Collect images but keep paths in text so the model can reference them
  let match: RegExpExecArray | null;
  IMAGE_PATH_RE.lastIndex = 0;
  while ((match = IMAGE_PATH_RE.exec(input)) !== null) {
    const filePath = match[1];
    const resolved = filePath.startsWith('~/')
      ? path.join(process.env.HOME || '', filePath.slice(1))
      : path.resolve(filePath);
    try {
      if (!fs.existsSync(resolved)) continue;
      const buf = fs.readFileSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mediaType: ImageInput['mediaType'] =
        ext === '.png' ? 'image/png'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : 'image/jpeg';
      images.push({ data: buf.toString('base64'), mediaType });
    } catch (e) {
      // skip unreadable files
    }
  }

  return { text: input || (images.length > 0 ? '请描述这张图片' : ''), images };
}

export async function chat(userInput: string): Promise<void> {
  try {
    const { text, images } = extractLocalImages(userInput);
    if (images.length > 0) {
      log.dim(`📎 已加载 ${images.length} 张图片`);
    }
    await runAgenticChat(conversationHistory, text, getCurrentUser(), {
      streamEnabled: true,
      showThinking: showThinking(),
      agentConfig: getCurrentAgent(),
      images: images.length > 0 ? images : undefined,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    const msg = err?.message ?? String(err);
    log.print(`AI 请求失败: ${msg}`);
  }
}

export function resetConversation(): void {
  conversationHistory = [];
  setCurrentAgent(undefined);
}
