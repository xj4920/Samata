import Anthropic from '@anthropic-ai/sdk';
import { getProvider, getModelName, type CreateMessageParams, type CreateMessageResult } from './provider.js';
import { getDb } from '../db/connection.js';
import { getCurrentUser, isAdmin, type User } from '../auth/rbac.js';
import { Client, ClientState, STATE_LABELS, STATES, nextState } from '../models/client.js';
import { recordEvent, getEvents } from '../models/event.js';
import { getAllSkills, getSkillByName } from '../commands/skill.js';
import { loadCustomers } from '../config/customers.js';
import { fetchTrades } from '../commands/trade.js';
import { log } from '../utils/logger.js';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

const showThinking = () => process.env.SHOW_THINKING !== 'false';

const tools: Anthropic.Tool[] = [
  {
    name: 'query_clients',
    description: '查询客户列表，支持按状态、名称关键词筛选',
    input_schema: {
      type: 'object' as const,
      properties: {
        state: { type: 'string', description: '客户状态: initial_contact, requirement_discussion, solution_design, uat, prod' },
        keyword: { type: 'string', description: '按名称模糊搜索' },
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
    description: '获取各阶段客户数量统计概览',
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
    description: '查询交易成交记录。支持按管理人名称(client)、交易对手(party)、用户ID(user)、日期(date)过滤。管理人与交易对手为1:N映射关系，指定client会自动展开为其下所有交易对手。',
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
];

// --- Constants ---
const PROJECT_ROOT = process.cwd() + '/';
const FORBIDDEN_PATTERNS = ['.env', 'node_modules/', 'data/*.db', '.git/'];

// --- Tool handlers ---

function findClient(nameOrId: string): Client | null {
  const db = getDb();
  // Try by name first (case-insensitive)
  let rows = db.prepare('SELECT * FROM clients WHERE name LIKE ? COLLATE NOCASE').all(`%${nameOrId}%`) as Client[];
  if (rows.length === 1) return rows[0];
  // Try by ID prefix
  if (rows.length === 0) {
    rows = db.prepare('SELECT * FROM clients WHERE id LIKE ?').all(`${nameOrId}%`) as Client[];
  }
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) {
    return rows[0]; // Return first match for LLM context
  }
  return null;
}

function handleQueryClients(input: { state?: string; keyword?: string }): string {
  const db = getDb();
  let sql = 'SELECT * FROM clients';
  const conditions: string[] = [];
  const params: any[] = [];

  if (input.state && STATES.includes(input.state as ClientState)) {
    conditions.push('state = ?');
    params.push(input.state);
  }
  if (input.keyword) {
    conditions.push('(name LIKE ? COLLATE NOCASE OR wework_group LIKE ? COLLATE NOCASE)');
    params.push(`%${input.keyword}%`, `%${input.keyword}%`);
  }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY updated_at DESC';

  const rows = db.prepare(sql).all(...params) as Client[];
  return JSON.stringify(rows.map(c => ({
    id: c.id.slice(0, 8),
    name: c.name,
    wework_group: c.wework_group,
    requirements: c.requirements,
    sales: c.sales,
    contact: c.contact,
    state: STATE_LABELS[c.state],
    tags: c.tags,
    notes: c.notes,
    updated_at: c.updated_at,
  })));
}

function handleViewClient(input: { name_or_id: string }): string {
  const client = findClient(input.name_or_id);
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
  const client = findClient(input.name_or_id);
  if (!client) return JSON.stringify({ error: `未找到客户: ${input.name_or_id}` });
  const events = getEvents(client.id);
  return JSON.stringify(events.map(e => ({
    action: e.action,
    payload: e.payload,
    time: e.created_at,
  })));
}

function handleStatusSummary(): string {
  const db = getDb();
  const rows = db.prepare('SELECT state, COUNT(*) as count FROM clients GROUP BY state').all() as { state: ClientState; count: number }[];
  const countMap = new Map(rows.map(r => [r.state, r.count]));
  const result = STATES.map(s => ({ state: STATE_LABELS[s], count: countMap.get(s) ?? 0 }));
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  result.push({ state: '合计', count: total });
  return JSON.stringify(result);
}

function handleSearchKnowledge(input: { keyword: string }): string {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM knowledge WHERE question LIKE ? OR answer LIKE ? OR tags LIKE ? ORDER BY created_at DESC'
  ).all(`%${input.keyword}%`, `%${input.keyword}%`, `%${input.keyword}%`) as any[];
  if (rows.length === 0) return JSON.stringify({ message: '未找到相关FAQ' });
  return JSON.stringify(rows.map(r => ({ question: r.question, answer: r.answer, tags: r.tags })));
}

function handleAddClient(input: { name: string; contact?: string; wework_group?: string; requirements?: string; sales?: string; notes?: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  const db = getDb();
  const user = getCurrentUser();
  const id = uuid();
  db.prepare('INSERT INTO clients (id, name, contact, wework_group, requirements, sales, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.name, input.contact ?? null, input.wework_group ?? null, input.requirements ?? null, input.sales ?? null, input.notes ?? null, user.id);
  recordEvent('client', id, 'create', { name: input.name });
  return JSON.stringify({ success: true, id: id.slice(0, 8), name: input.name });
}

function handleUpdateClient(input: { name_or_id: string; fields: Record<string, string> }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  const client = findClient(input.name_or_id);
  if (!client) return JSON.stringify({ error: `未找到客户: ${input.name_or_id}` });

  const db = getDb();
  const allowed = ['name', 'contact', 'wework_group', 'requirements', 'sales', 'tags', 'notes'];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(input.fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return JSON.stringify({ error: '没有可更新的字段' });

  sets.push("updated_at = datetime('now')");
  vals.push(client.id);
  db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  recordEvent('client', client.id, 'update', input.fields);
  return JSON.stringify({ success: true, name: client.name });
}

function handleAdvanceClient(input: { name_or_id: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  const client = findClient(input.name_or_id);
  if (!client) return JSON.stringify({ error: `未找到客户: ${input.name_or_id}` });

  const next = nextState(client.state);
  if (!next) return JSON.stringify({ error: `客户已处于最终状态: ${STATE_LABELS[client.state]}` });

  const db = getDb();
  db.prepare("UPDATE clients SET state = ?, updated_at = datetime('now') WHERE id = ?").run(next, client.id);
  recordEvent('client', client.id, 'advance', { from: client.state, to: next });
  return JSON.stringify({ success: true, name: client.name, from: STATE_LABELS[client.state], to: STATE_LABELS[next] });
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
  const db = getDb();
  const user = getCurrentUser();
  const existing = getSkillByName(input.name);

  if (existing) {
    db.prepare('UPDATE skills SET prompt = ? WHERE name = ?').run(input.prompt, input.name);
    recordEvent('skill', existing.id, 'update', { name: input.name, prompt: input.prompt });
    return JSON.stringify({ success: true, action: 'updated', name: input.name });
  } else {
    const id = uuid();
    db.prepare('INSERT INTO skills (id, name, prompt, created_by) VALUES (?, ?, ?, ?)').run(id, input.name, input.prompt, user.id);
    recordEvent('skill', id, 'create', { name: input.name, prompt: input.prompt });
    return JSON.stringify({ success: true, action: 'created', name: input.name, id: id.slice(0, 8) });
  }
}

function handleDeleteSkill(input: { name: string }): string {
  const skill = getSkillByName(input.name);
  if (!skill) return JSON.stringify({ error: `未找到 skill: ${input.name}` });
  const db = getDb();
  db.prepare('DELETE FROM skills WHERE id = ?').run(skill.id);
  recordEvent('skill', skill.id, 'delete', { name: input.name });
  return JSON.stringify({ success: true, name: input.name });
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
  // Use setTimeout to allow the tool result to be returned before exiting
  setTimeout(() => {
    process.exit(120);
  }, 500);
  return JSON.stringify({ success: true, message: '应用将在 0.5 秒后重启' });
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
    case 'query_trades': return handleQueryTrades(input);
    case 'list_customers': return handleListCustomers();
    case 'list_skills': return handleListSkills();
    case 'get_skill': return handleGetSkill(input);
    case 'list_directory': return handleListDirectory(input);
    case 'read_file': return handleReadFile(input);
    case 'save_skill': return handleSaveSkill(input);
    case 'delete_skill': return handleDeleteSkill(input);
    case 'write_file': return handleWriteFile(input);
    case 'reload_app': return handleReloadApp();
    default: return JSON.stringify({ error: `未知工具: ${name}` });
  }
}

// --- Conversation state ---
let conversationHistory: Anthropic.MessageParam[] = [];

export function getTools(): Anthropic.Tool[] {
  return tools;
}

export function getSystemPrompt(user?: User): string {
  const u = user ?? getCurrentUser();
  return `你是衍语展业助手。你可以：
1. 查询和管理客户信息（客户状态流转：Initial Contact → Requirement Discussion → Solution Design → UAT → PROD）
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
- 给出展业建议时结合客户的实际状态和需求`;
}

/**
 * 调用 LLM，优先使用流式输出（CLI 逐字显示），回退到非流式
 * 返回 { result, streamed } — streamed 表示文本已经输出到 stdout
 */
async function callLLM(params: CreateMessageParams, streamText: boolean): Promise<{ result: CreateMessageResult; streamed: boolean }> {
  const provider = getProvider();

  if (streamText && provider.createMessageStream) {
    let result: CreateMessageResult | null = null;
    let hasTextOutput = false;
    for await (const event of provider.createMessageStream(params)) {
      if (event.type === 'text_delta') {
        if (!hasTextOutput) { console.log(); hasTextOutput = true; }
        process.stdout.write(event.text);
      } else if (event.type === 'done') {
        result = { content: event.content, stop_reason: event.stop_reason };
      }
    }
    if (hasTextOutput) console.log('\n');
    if (!result) throw new Error('Stream ended without done event');
    return { result, streamed: hasTextOutput };
  }

  return { result: await provider.createMessage(params), streamed: false };
}

export async function chat(userInput: string): Promise<void> {
  conversationHistory.push({ role: 'user', content: userInput });

  const makeParams = (): CreateMessageParams => ({
    model: getModelName(),
    max_tokens: 4096,
    system: getSystemPrompt(),
    tools,
    messages: conversationHistory,
  });

  // 首次调用也流式输出
  let { result: response, streamed } = await callLLM(makeParams(), true);

  // Agentic loop: keep processing until no more tool calls
  while (response.stop_reason === 'tool_use') {
    const assistantContent = response.content;
    conversationHistory.push({ role: 'assistant', content: assistantContent });

    // Show thinking text from assistant (skip if already streamed)
    if (!streamed && showThinking()) {
      for (const block of assistantContent) {
        if (block.type === 'text' && block.text) {
          log.dim(`💭 ${block.text}`);
        }
      }
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        if (showThinking()) {
          log.dim(`🔧 调用工具: ${block.name}`);
          log.dim(`   参数: ${JSON.stringify(block.input)}`);
        }
        const result = await executeTool(block.name, block.input);
        if (showThinking()) {
          const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
          log.dim(`   结果: ${preview}`);
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    conversationHistory.push({ role: 'user', content: toolResults });

    // 下一轮调用：流式输出（如果最终是文本回复则逐字显示）
    ({ result: response, streamed } = await callLLM(makeParams(), true));
  }

  const assistantContent = response.content;
  conversationHistory.push({ role: 'assistant', content: assistantContent });

  // 如果文本已经通过流式输出，不重复打印
  if (!streamed) {
    for (const block of assistantContent) {
      if (block.type === 'text') {
        console.log();
        log.info(block.text);
        console.log();
      }
    }
  }
}

export function resetConversation(): void {
  conversationHistory = [];
}
