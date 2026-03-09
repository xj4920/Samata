import Anthropic from '@anthropic-ai/sdk';
import { getProvider, getModelName, type CreateMessageParams, type CreateMessageResult } from './provider.js';
import { getCurrentUser, isAdmin, type User } from '../auth/rbac.js';
import { fetchSystemStatus } from '../commands/monitor.js';
import { STATE_LABELS, STATE_PRIORITY } from '../models/client.js';
import { getAllSkills, getSkillByName, saveSkill, deleteSkill } from '../commands/skill.js';
import { fetchClients, fetchClient, fetchHistory, createClient, updateClient, advanceClient, rollbackClient } from '../commands/client.js';
import { fetchKnowledge } from '../commands/knowledge.js';
import { loadCustomers } from '../config/customers.js';
import { fetchTrades, fetchLatestNotionals } from '../commands/trade.js';
import { plotTrades } from '../commands/plot.js';
import { extractWeworkQA } from '../commands/wework-qa.js';
import { log } from '../utils/logger.js';
import { throwIfAborted } from '../utils/abort.js';
import { renderMarkdown } from '../utils/markdown.js';
import * as fs from 'fs';
import * as path from 'path';

const showThinking = () => process.env.SHOW_THINKING !== 'false';

const tools: Anthropic.Tool[] = [
  {
    name: 'query_clients',
    description: '查询客户列表。重要：当用户询问特定类型/特征的客户时（如"极速客户"、"VIP客户"、"常速客户"、"某某公司"），必须提取关键词并使用keyword参数进行筛选，不要返回全量数据。支持按状态(state)和关键词(keyword)筛选。',
    input_schema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string', description: '客户状态: initial_contact, requirement_discussion, solution_design, uat, prod' },
        keyword: { type: 'string', description: '关键词模糊搜索（匹配客户名称、企微群名、标签）。示例：用户问"极速客户"→传入"极速"；问"VIP客户"→传入"VIP"；问"常速客户"→传入"常速"；问"某某公司"→传入"某某"。重要：除非用户明确要求"所有客户"或"全部客户"，否则必须提取并传入关键词，不要留空。' },
      },
      required: [],
    },
  },
  {
    name: 'view_client',
    description: '查看某个客户的详细信息',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'get_client_history',
    description: '查看某个客户的操作历史记录',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'get_status_summary',
    description: '获取系统状态概览（版本、模型、服务运行状态、知识库/Skill数量、运行时长等）',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'search_knowledge',
    description: '搜索知识库中的FAQ',
    input_schema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'add_client',
    description: '添加新客户（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: '客户名称' },
        contact: { type: 'string', description: '联系方式' },
        wework_group: { type: 'string', description: 'WeWork Group' },
        requirements: { type: 'string', description: '需求' },
        sales: { type: 'string', description: '销售' },
        notes: { type: 'string', description: '备注' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_client',
    description: '更新客户信息（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
        fields: {
          type: 'object' as const,
          description: '要更新的字段，如 { "wework_group": "xx", "contact": "xx" }',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['name_or_id', 'fields'],
    },
  },
  {
    name: 'advance_client',
    description: '推进客户到下一个阶段（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'rollback_client',
    description: '回退客户到上一个阶段（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        name_or_id: { type: 'string', description: '客户名称或ID前缀' },
      },
      required: ['name_or_id'],
    },
  },
  {
    name: 'list_skills',
    description: '列出所有已保存的 skill（可复用的提示词模板）',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_skill',
    description: '获取某个 skill 的详细信息（名称和 prompt 模板）',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'skill 名称' },
      },
      required: ['name'],
    },
  },
  {
    name: 'query_trades',
    description: '查询交易成交记录。支持按管理人名称(client)、交易对手(party)、用户ID(user)、日期(date)过滤。管理人与交易对手为1:N映射关系，指定client会自动展开为其下所有交易对手。返回字段说明：notional_t=T日存续名义本金，trade_amt_ft=T日成交金额，ft_net=净交易头寸（非盈亏）。',
    input_schema: {
      type: 'object' as const,
      properties: {
        client: { type: 'string', description: '管理人名称，如 JINDE、JUPITER、JUMP 等，会自动映射到其下所有交易对手' },
        party: { type: 'string', description: '交易对手名称，精确匹配' },
        user: { type: 'string', description: '用户ID' },
        date: { type: 'string', description: '交易日期，格式 YYYYMMDD' },
        limit: { type: 'number', description: '返回条数上限，默认50' },
      },
      required: [],
    },
  },
  {
    name: 'plot_trades',
    description: '绘制交易曲线图（存续名义本金、成交金额、净头寸），生成HTML在浏览器中打开。适合用户要求"画图"、"图表"、"趋势"时调用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        client: { type: 'string', description: '管理人名称，如 JUMP、JINDE' },
        party: { type: 'string', description: '交易对手名称' },
        limit: { type: 'number', description: '数据条数上限，默认200' },
      },
      required: [],
    },
  },
  {
    name: 'list_customers',
    description: '列出所有管理人及其关联的交易对手/产品列表',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_directory',
    description: '列出指定目录下的文件和子目录',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '目录路径（绝对路径或相对路径）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: '读取指定文件的内容',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '文件路径（绝对路径或相对路径）' },
        max_lines: { type: 'number', description: '最多读取行数，默认500' },
      },
      required: ['path'],
    },
  },
  {
    name: 'save_skill',
    description: '创建或更新一个 skill（可复用的提示词模板），支持 {param} 占位符',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'skill 名称' },
        prompt: { type: 'string', description: 'skill 的 prompt 模板，支持 {param} 占位符' },
      },
      required: ['name', 'prompt'],
    },
  },
  {
    name: 'delete_skill',
    description: '删除一个已有的 skill',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: '要删除的 skill 名称' },
      },
      required: ['name'],
    },
  },
  {
    name: 'write_file',
    description: '写入文件内容（仅限项目目录内，仅管理员可用）。可用于修改或新增源代码文件。',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '文件路径（相对于项目根目录或绝对路径）' },
        content: { type: 'string', description: '要写入的文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'reload_app',
    description: '触发应用热重载，使代码变更生效（仅管理员可用）。会以退出码 120 退出，由 launcher 自动重启。',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'extract_wework_qa',
    description: '从企业微信聊天记录中提取有价值的问答对（Q&A pairs）。使用 LLM 智能识别问题和答案，适合用于知识库构建、FAQ 整理等场景。支持多关键词搜索。',
    input_schema: {
      type: 'object' as const,
      properties: {
        topics: { type: 'array', items: { type: 'string' }, description: '主题关键词列表，用于过滤相关消息。应拆分为多个短关键词，如["期货手数","流速控制","限额"]' },
        people: { type: 'array', items: { type: 'string' }, description: '相关人员名称列表，用于过滤发送人（可选）' },
        start_date: { type: 'string', description: '开始日期，格式 YYYY-MM-DD（可选）' },
        end_date: { type: 'string', description: '结束日期，格式 YYYY-MM-DD（可选）' },
        session: { type: 'string', description: '群聊名称，模糊匹配（可选）' },
        limit: { type: 'number', description: '返回 Q&A 对数量上限，默认 10' },
      },
      required: [],
    },
  },
];

// --- Constants ---
const PROJECT_ROOT = process.cwd() + '/';
const FORBIDDEN_PATTERNS = ['.env', 'node_modules/', 'data/*.db', '.git/'];

// --- Tool handlers ---

async function handleQueryClients(input: { state?: string; keyword?: string }): Promise<string> {
  const rows = fetchClients(input);

  let notionals = new Map<string, number>();
  try {
    notionals = await fetchLatestNotionals();
  } catch {}

  rows.sort((a, b) => {
    const stateDiff = (STATE_PRIORITY[b.state] ?? 0) - (STATE_PRIORITY[a.state] ?? 0);
    if (stateDiff !== 0) return stateDiff;
    return (notionals.get(b.name.toLowerCase()) ?? 0) - (notionals.get(a.name.toLowerCase()) ?? 0);
  });

  return JSON.stringify(rows.map(c => ({
    id: c.id.slice(0, 8),
    name: c.name,
    wework_group: c.wework_group,
    requirements: c.requirements,
    sales: c.sales,
    contact: c.contact,
    state: STATE_LABELS[c.state],
    notional_t: notionals.get(c.name.toLowerCase()) ?? null,
    tags: c.tags,
    notes: c.notes,
    created_at: c.created_at,
    updated_at: c.updated_at,
  })));
}

function handleViewClient(input: { name_or_id: string }): string {
  const client = fetchClient(input.name_or_id);
  if (!client) return JSON.stringify({ error: `未找到客户: ${input.name_or_id}` });
  return JSON.stringify({
    id: client.id,
    name: client.name,
    wework_group: client.wework_group,
    requirements: client.requirements,
    sales: client.sales,
    contact: client.contact,
    state: STATE_LABELS[client.state],
    tags: client.tags,
    notes: client.notes,
    created_at: client.created_at,
    updated_at: client.updated_at,
  });
}

function handleGetHistory(input: { name_or_id: string }): string {
  const result = fetchHistory(input.name_or_id);
  if (!result) return JSON.stringify({ error: `未找到客户: ${input.name_or_id}` });
  return JSON.stringify(result.events.map(e => ({
    action: e.action,
    payload: e.payload,
    time: e.created_at,
  })));
}

function handleStatusSummary(): string {
  return JSON.stringify(fetchSystemStatus());
}

function handleSearchKnowledge(input: { keyword: string }): string {
  const rows = fetchKnowledge(input.keyword);
  if (rows.length === 0) return JSON.stringify({ message: '未找到相关FAQ' });
  return JSON.stringify(rows.map(r => ({ question: r.question, answer: r.answer, tags: r.tags })));
}

function handleAddClient(input: { name: string; contact?: string; wework_group?: string; requirements?: string; sales?: string; notes?: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  return JSON.stringify(createClient(input));
}

function handleUpdateClient(input: { name_or_id: string; fields: Record<string, string> }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  return JSON.stringify(updateClient(input.name_or_id, input.fields));
}

function handleAdvanceClient(input: { name_or_id: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  return JSON.stringify(advanceClient(input.name_or_id));
}

function handleRollbackClient(input: { name_or_id: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  return JSON.stringify(rollbackClient(input.name_or_id));
}

function handleListSkills(): string {
  const skills = getAllSkills();
  return JSON.stringify(skills.map(s => ({
    name: s.name,
    prompt: s.prompt,
    params: [...s.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]),
  })));
}

function handleGetSkill(input: { name: string }): string {
  const skill = getSkillByName(input.name);
  if (!skill) return JSON.stringify({ error: `未找到 skill: ${input.name}` });
  return JSON.stringify({
    name: skill.name,
    prompt: skill.prompt,
    params: [...skill.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]),
  });
}

async function handleQueryTrades(input: { client?: string; party?: string; user?: string; date?: string; limit?: number }): Promise<string> {
  try {
    const rows = await fetchTrades(input);
    if (rows.length === 0) return JSON.stringify({ message: '未查询到交易数据' });
    return JSON.stringify(rows);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

async function handlePlotTrades(input: { client?: string; party?: string; limit?: number }): Promise<string> {
  try {
    const filePath = await plotTrades(input);
    return JSON.stringify({ success: true, message: '图表已在浏览器中打开', path: filePath });
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

function handleListCustomers(): string {
  const customers = loadCustomers();
  return JSON.stringify(customers.map(c => ({
    name: c.name,
    sales: c.sales,
    products: c.products.map(p => p.counter_party),
  })));
}

function handleListDirectory(input: { path: string }): string {
  const dirPath = input.path.startsWith('~')
    ? input.path.replace('~', process.env.HOME || '')
    : input.path;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
    }));
    return JSON.stringify(result);
  } catch (err: any) {
    return JSON.stringify({ error: `无法读取目录: ${err.message}` });
  }
}

function handleReadFile(input: { path: string; max_lines?: number }): string {
  const filePath = input.path.startsWith('~')
    ? input.path.replace('~', process.env.HOME || '')
    : input.path;
  const maxLines = input.max_lines ?? 500;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n...(共 ${lines.length} 行，已截断前 ${maxLines} 行)`;
    }
    return content;
  } catch (err: any) {
    return JSON.stringify({ error: `无法读取文件: ${err.message}` });
  }
}

function handleSaveSkill(input: { name: string; prompt: string }): string {
  return JSON.stringify(saveSkill(input.name, input.prompt));
}

function handleDeleteSkill(input: { name: string }): string {
  return JSON.stringify(deleteSkill(input.name));
}

function handleWriteFile(input: { path: string; content: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });

  // Resolve to absolute path
  let filePath = input.path;
  if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(PROJECT_ROOT, filePath);
  }
  filePath = path.normalize(filePath);

  // Must be within project root
  if (!filePath.startsWith(PROJECT_ROOT)) {
    return JSON.stringify({ error: `路径不在项目目录内: ${filePath}` });
  }

  // Check forbidden patterns
  const relative = filePath.slice(PROJECT_ROOT.length);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.endsWith('/')) {
      if (relative.startsWith(pattern) || relative.includes('/' + pattern)) {
        return JSON.stringify({ error: `禁止写入路径: ${relative}` });
      }
    } else if (pattern.includes('*')) {
      const [dir, ext] = pattern.split('*');
      if (relative.startsWith(dir) && relative.endsWith(ext)) {
        return JSON.stringify({ error: `禁止写入路径: ${relative}` });
      }
    } else {
      if (relative === pattern || relative.endsWith('/' + pattern)) {
        return JSON.stringify({ error: `禁止写入路径: ${relative}` });
      }
    }
  }

  try {
    // Ensure parent directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, input.content, 'utf-8');
    return JSON.stringify({ success: true, path: relative, bytes: Buffer.byteLength(input.content, 'utf-8') });
  } catch (err: any) {
    return JSON.stringify({ error: `写入失败: ${err.message}` });
  }
}

function handleReloadApp(): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  log.info('🔄 即将重载应用...');
  setTimeout(async () => {
    const { gracefulShutdown } = await import('../index.js');
    gracefulShutdown();
    process.exit(120);
  }, 500);
  return JSON.stringify({ success: true, message: '应用将在 0.5 秒后重启' });
}

async function handleExtractWeworkQA(input: {
  topics?: string[];
  people?: string[];
  start_date?: string;
  end_date?: string;
  session?: string;
  limit?: number;
}): Promise<string> {
  try {
    const qaPairs = await extractWeworkQA({
      topics: input.topics,
      people: input.people,
      startDate: input.start_date,
      endDate: input.end_date,
      session: input.session,
      limit: input.limit,
      verbose: false,
    });
    if (qaPairs.length === 0) {
      return JSON.stringify({ message: '未提取到有价值的 Q&A 对' });
    }
    return JSON.stringify(qaPairs);
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

export async function executeTool(name: string, input: any): Promise<string> {
  switch (name) {
    case 'query_clients': return handleQueryClients(input);
    case 'view_client': return handleViewClient(input);
    case 'get_client_history': return handleGetHistory(input);
    case 'get_status_summary': return handleStatusSummary();
    case 'search_knowledge': return handleSearchKnowledge(input);
    case 'add_client': return handleAddClient(input);
    case 'update_client': return handleUpdateClient(input);
    case 'advance_client': return handleAdvanceClient(input);
    case 'rollback_client': return handleRollbackClient(input);
    case 'query_trades': return handleQueryTrades(input);
    case 'plot_trades': return handlePlotTrades(input);
    case 'list_customers': return handleListCustomers();
    case 'list_skills': return handleListSkills();
    case 'get_skill': return handleGetSkill(input);
    case 'list_directory': return handleListDirectory(input);
    case 'read_file': return handleReadFile(input);
    case 'save_skill': return handleSaveSkill(input);
    case 'delete_skill': return handleDeleteSkill(input);
    case 'write_file': return handleWriteFile(input);
    case 'reload_app': return handleReloadApp();
    case 'extract_wework_qa': return handleExtractWeworkQA(input);
    default: return JSON.stringify({ error: `未知工具: ${name}` });
  }
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

export function getTools(): Anthropic.Tool[] {
  return tools;
}

export function getSystemPrompt(user?: User): string {
  const u = user ?? getCurrentUser();
  return `你是 OTC Claw。你可以：
1. 查询和管理客户信息（客户状态流转：Initial Contact ↔ Requirement Discussion ↔ Solution Design ↔ UAT ↔ PROD，支持 advance 推进和 rollback 回退）
2. 查询交易成交数据 — 支持按管理人名称(client)查询，会自动展开为其下所有交易对手
3. 回答关于客户的问题，提供数据分析
4. 提供展业建议和话术参考
5. 搜索知识库回答常见问题
5. 工具自举：你可以根据实际需要创建新的 skill、修改项目源代码、并触发热重载使变更生效。
   - 使用 save_skill 创建可复用的提示词模板
   - 使用 write_file 修改或新增源代码文件（仅限项目目录内）
   - 修改代码后使用 reload_app 重启应用使变更生效
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
async function callLLM(params: CreateMessageParams, streamText: boolean, showThinkingOpt: boolean = false): Promise<{ result: CreateMessageResult; streamed: boolean }> {
  const provider = getProvider();

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
  } = {}
): Promise<string> {
  const { streamEnabled = false, logPrefix = '', showThinking: showThinkingOpt = showThinking() } = options;

  trimHistory(history);

  const historyLenBefore = history.length;
  history.push({ role: 'user', content: userInput });

  const makeParams = (): CreateMessageParams => ({
    model: getModelName(),
    max_tokens: 4096,
    system: getSystemPrompt(user),
    tools,
    messages: history,
  });

  let response: CreateMessageResult;
  let streamed: boolean;
  try {
    ({ result: response, streamed } = await callLLM(makeParams(), streamEnabled, showThinkingOpt));
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
        throwIfAborted();
        let result: string;
        try {
          result = await executeTool(block.name, block.input);
        } catch (err: any) {
          result = JSON.stringify({ error: `工具执行异常: ${err.message}` });
        }
        if (showThinkingOpt) {
          const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
          log.dim(`${logPrefix}   结果: ${preview}`);
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    history.push({ role: 'user', content: toolResults });

    try {
      ({ result: response, streamed } = await callLLM(makeParams(), streamEnabled, showThinkingOpt));
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

  return textReply;
}

export async function chat(userInput: string): Promise<void> {
  try {
    await runAgenticChat(conversationHistory, userInput, getCurrentUser(), {
      streamEnabled: true,
      showThinking: showThinking(),
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    const msg = err?.message ?? String(err);
    log.print(`AI 请求失败: ${msg}`);
  }
}

export function resetConversation(): void {
  conversationHistory = [];
}
