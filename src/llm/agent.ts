import Anthropic from '@anthropic-ai/sdk';
import { getProvider, getProviderName, getProviderByName, getModelName, type CreateMessageParams, type CreateMessageResult } from './provider.js';
import { getCurrentUser, isAdmin, type User } from '../auth/rbac.js';
import type { AgentConfig } from './agents/config.js';
import { getAgentTools, getDefaultAgent, getAllAgents, getAgent, saveAgent, deleteAgent, saveAssignment, deleteAssignment, listAssignments, TOOL_PRESETS } from './agents/config.js';
import { buildSystemPrompt } from './agents/prompt.js';
import { saveMemory as saveMemoryFn, searchMemory as searchMemoryFn, deleteMemory as deleteMemoryFn, updateMemory as updateMemoryFn } from './agents/memory.js';
import { fetchSystemStatus } from '../commands/monitor.js';
import { STATE_LABELS, STATE_PRIORITY } from '../models/client.js';
import { getAllSkills, getSkillByName, saveSkill, deleteSkill } from '../commands/skill.js';
import { fetchClients, fetchClient, fetchHistory, createClient, updateClient, advanceClient, rollbackClient } from '../commands/client.js';
import { fetchKnowledge, updateKnowledgeById, assignKnowledgeToAgent, unassignKnowledgeFromAgent, getKnowledgeAgents } from '../commands/knowledge.js';
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
    description: '搜索知识库中的FAQ。支持多关键词搜索（空格分隔），会自动拆分并匹配。建议传入2-3个核心关键词而非完整句子。例如：用户问"专线怎么申请"→传入"专线 申请"；问"北向极速开通流程"→传入"北向 极速 开通"。如果首次搜索无结果，尝试减少关键词或换用同义词重试。',
    input_schema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: '搜索关键词（多个关键词用空格分隔，匹配任一即返回，全部匹配排在前面）' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'update_knowledge',
    description: '更新知识库中已有的FAQ条目（仅管理员）。需先通过 search_knowledge 搜索找到目标QA，再用ID前缀进行更新。支持修改问题、答案、标签等字段。',
    input_schema: {
      type: 'object' as const,
      properties: {
        id_prefix: { type: 'string', description: 'FAQ的ID或ID前缀（通过 search_knowledge 获取）' },
        fields: {
          type: 'object' as const,
          description: '要更新的字段，如 { "question": "新问题", "answer": "新答案", "tags": "标签1,标签2" }',
          properties: {
            question: { type: 'string', description: '问题' },
            answer: { type: 'string', description: '答案' },
            tags: { type: 'string', description: '标签（逗号分隔）' },
            related_users: { type: 'string', description: '相关人员（逗号分隔）' },
          },
        },
      },
      required: ['id_prefix', 'fields'],
    },
  },
  {
    name: 'assign_knowledge_agent',
    description: '将知识条目关联到指定 Agent，使该 Agent 可通过 search_knowledge 搜索到该条目（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        knowledge_id: { type: 'string', description: '知识条目 ID 或 ID 前缀（通过 search_knowledge 获取）' },
        agent_name: { type: 'string', description: 'Agent 名称（如 otcclaw、doctor、tutor）' },
      },
      required: ['knowledge_id', 'agent_name'],
    },
  },
  {
    name: 'unassign_knowledge_agent',
    description: '解除知识条目与指定 Agent 的关联（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        knowledge_id: { type: 'string', description: '知识条目 ID 或 ID 前缀' },
        agent_name: { type: 'string', description: 'Agent 名称' },
      },
      required: ['knowledge_id', 'agent_name'],
    },
  },
  {
    name: 'get_knowledge_agents',
    description: '查询某条知识条目关联了哪些 Agent',
    input_schema: {
      type: 'object' as const,
      properties: {
        knowledge_id: { type: 'string', description: '知识条目 ID 或 ID 前缀' },
      },
      required: ['knowledge_id'],
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
    description: '创建或更新一个 skill（可复用的提示词模板），支持 {param} 占位符。可指定 scope 为当前 Agent 专属',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'skill 名称' },
        prompt: { type: 'string', description: 'skill 的 prompt 模板，支持 {param} 占位符' },
        scope: { type: 'string', description: "'global'（全局，所有 Agent 可用）或 'agent'（仅当前 Agent 可用）。默认 global" },
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
    description: '写入文件内容（仅限项目目录内，仅管理员可用）。可用于新建文件。修改已有文件请优先使用 edit_file。',
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
    name: 'edit_file',
    description: '搜索并替换文件中的指定内容（仅限项目目录内，仅管理员可用）。适合对已有文件做局部修改，无需重写整个文件。old_text 必须与文件中的内容完全匹配（包括缩进和换行）。',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '文件路径（相对于项目根目录或绝对路径）' },
        old_text: { type: 'string', description: '要被替换的原始文本（必须精确匹配文件中的内容）' },
        new_text: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old_text', 'new_text'],
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
  // --- Agent management tools ---
  {
    name: 'list_agents',
    description: '列出所有可用的 Agent',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_agent',
    description: '查看某个 Agent 的详细配置',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Agent 名称' } },
      required: ['name'],
    },
  },
  {
    name: 'save_agent',
    description: '创建或更新 Agent（仅管理员）。支持 LLM 自举创建新 Agent。',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Agent 唯一名称（英文）' },
        display_name: { type: 'string', description: 'Agent 显示名称' },
        description: { type: 'string', description: 'Agent 职责描述' },
        system_prompt: { type: 'string', description: '自定义 system prompt（不传则使用默认）' },
        model: { type: 'string', description: '指定模型（不传则使用全局默认）' },
        provider: { type: 'string', description: '指定 provider（不传则使用全局默认）' },
        tools_mode: { type: 'string', description: "'all' | 'allowlist' | 'blocklist'" },
        tools_list: { type: 'array', items: { type: 'string' }, description: '工具名称列表（配合 tools_mode 使用）' },
        max_history: { type: 'number', description: '最大历史消息数，默认 80' },
        preset: { type: 'string', description: "工具预设名称（'common' | 'alter_ego' | 'readonly'），设置后自动填充 tools_list，tools_mode 为 allowlist" },
      },
      required: ['name', 'display_name'],
    },
  },
  {
    name: 'delete_agent',
    description: '删除 Agent（仅管理员，不可删除默认 agent）',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Agent 名称' } },
      required: ['name'],
    },
  },
  {
    name: 'switch_agent',
    description: '切换当前会话使用的 Agent。切换后会清空对话历史。',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: '要切换到的 Agent 名称' } },
      required: ['name'],
    },
  },
  // --- Agent assignment tools ---
  {
    name: 'assign_agent',
    description: '将 Agent 绑定到指定渠道或用户。可设置渠道默认或用户专属 Agent。',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_name: { type: 'string', description: 'Agent 名称' },
        channel: { type: 'string', description: "渠道: 'feishu' | 'telegram' | 'cli'" },
        target_id: { type: 'string', description: '可选：用户 ID（不传则设为渠道默认）' },
      },
      required: ['agent_name', 'channel'],
    },
  },
  {
    name: 'unassign_agent',
    description: '移除 Agent 绑定',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: "渠道: 'feishu' | 'telegram' | 'cli'" },
        target_id: { type: 'string', description: '可选：用户 ID（不传则移除渠道默认）' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'list_agent_assignments',
    description: '列出所有 Agent 绑定关系',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  // --- Memory management tools ---
  {
    name: 'save_memory',
    description: '保存一条记忆/事实到持久化存储，跨会话可用。当对话中出现重要事实、用户偏好、关键信息时主动调用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: '要记住的事实或信息（最大500字符）' },
        scope: { type: 'string', description: "'global'（全局，所有 Agent 可见）或 'agent'（仅当前 Agent 可见）。默认 global" },
        category: { type: 'string', description: "可选分类: 'fact' | 'preference' | 'rule' | 'context'" },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_memory',
    description: '搜索已保存的记忆/事实',
    input_schema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'update_memory',
    description: '修改一条已保存的记忆内容或分类（仅管理员）',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '记忆 ID 或 ID 前缀' },
        content: { type: 'string', description: '新的记忆内容（最大500字符）' },
        category: { type: 'string', description: "新的分类: 'fact' | 'preference' | 'rule' | 'context'" },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_memory',
    description: '删除一条已保存的记忆（仅 admin 可用）。需要提供记忆 ID 前缀。',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '要删除的记忆 ID（前缀匹配）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_tool_presets',
    description: '列出所有可用的工具预设（preset），用于创建 agent 时快速选择工具集',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'http_request',
    description: '发起 HTTP 请求，支持 GET/POST/PUT/DELETE 等方法。可用于调用外部 API、获取网页内容等。',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: '请求 URL' },
        method: { type: 'string', description: 'HTTP 方法：GET、POST、PUT、DELETE 等，默认 GET' },
        headers: {
          type: 'object' as const,
          description: '请求头（可选），如 { "Content-Type": "application/json", "Authorization": "Bearer xxx" }',
          additionalProperties: { type: 'string' },
        },
        body: { type: 'string', description: '请求体（可选），POST/PUT 时使用，JSON 字符串或纯文本' },
        timeout: { type: 'number', description: '超时时间（毫秒），默认 10000' },
      },
      required: ['url'],
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
  const agentId = getCurrentAgent()?.id;
  const rows = fetchKnowledge(input.keyword, agentId);
  if (rows.length === 0) return JSON.stringify({ message: '未找到相关FAQ，建议换用更短或不同的关键词重试' });
  return JSON.stringify(rows.map(r => ({
    id: r.id.slice(0, 8),
    question: r.question,
    answer: r.answer,
    tags: r.tags,
    relevance: (r as any).relevance,
  })));
}

function handleUpdateKnowledge(input: { id_prefix: string; fields: { question?: string; answer?: string; tags?: string; related_users?: string } }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  return JSON.stringify(updateKnowledgeById(input.id_prefix, input.fields));
}

function handleAssignKnowledgeAgent(input: { knowledge_id: string; agent_name: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  return JSON.stringify(assignKnowledgeToAgent(input.knowledge_id, input.agent_name));
}

function handleUnassignKnowledgeAgent(input: { knowledge_id: string; agent_name: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  return JSON.stringify(unassignKnowledgeFromAgent(input.knowledge_id, input.agent_name));
}

function handleGetKnowledgeAgents(input: { knowledge_id: string }): string {
  return JSON.stringify(getKnowledgeAgents(input.knowledge_id));
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
  const agentId = getCurrentAgent()?.id;
  const skills = getAllSkills(agentId);
  return JSON.stringify(skills.map(s => ({
    name: s.name,
    prompt: s.prompt,
    params: [...s.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]),
    agent_id: s.agent_id,
  })));
}

function handleGetSkill(input: { name: string }): string {
  const agentId = getCurrentAgent()?.id;
  const skill = getSkillByName(input.name, agentId);
  if (!skill) return JSON.stringify({ error: `未找到 skill: ${input.name}` });
  return JSON.stringify({
    name: skill.name,
    prompt: skill.prompt,
    params: [...skill.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]),
    agent_id: skill.agent_id,
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

function handleSaveSkill(input: { name: string; prompt: string; scope?: string }): string {
  const agentId = input.scope === 'agent' ? getCurrentAgent()?.id ?? undefined : undefined;
  return JSON.stringify(saveSkill(input.name, input.prompt, agentId));
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
    const willReload = markReloadIfSource(filePath);
    return JSON.stringify({ success: true, path: relative, bytes: Buffer.byteLength(input.content, 'utf-8'), reload: willReload });
  } catch (err: any) {
    return JSON.stringify({ error: `写入失败: ${err.message}` });
  }
}

function handleEditFile(input: { path: string; old_text: string; new_text: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });

  let filePath = input.path;
  if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(PROJECT_ROOT, filePath);
  }
  filePath = path.normalize(filePath);

  if (!filePath.startsWith(PROJECT_ROOT)) {
    return JSON.stringify({ error: `路径不在项目目录内: ${filePath}` });
  }

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
    if (!fs.existsSync(filePath)) {
      return JSON.stringify({ error: `文件不存在: ${relative}` });
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const idx = content.indexOf(input.old_text);
    if (idx === -1) {
      return JSON.stringify({ error: '未找到匹配的 old_text，请确认内容完全一致（包括缩进和换行）' });
    }
    // 检查是否有多处匹配
    const secondIdx = content.indexOf(input.old_text, idx + 1);
    if (secondIdx !== -1) {
      return JSON.stringify({ error: `old_text 在文件中匹配到多处（至少第 ${idx + 1} 和 ${secondIdx + 1} 字符处），请提供更精确的上下文以唯一定位` });
    }
    const newContent = content.slice(0, idx) + input.new_text + content.slice(idx + input.old_text.length);
    fs.writeFileSync(filePath, newContent, 'utf-8');
    const willReload = markReloadIfSource(filePath);
    return JSON.stringify({ success: true, path: relative, bytes: Buffer.byteLength(newContent, 'utf-8'), reload: willReload });
  } catch (err: any) {
    return JSON.stringify({ error: `编辑失败: ${err.message}` });
  }
}

let pendingReload = false;

const SOURCE_EXT = /\.(ts|js|mts|mjs|json)$/;

function markReloadIfSource(filePath: string): boolean {
  if (SOURCE_EXT.test(filePath)) {
    pendingReload = true;
    return true;
  }
  return false;
}

function handleReloadApp(): string {
  if (!isAdmin()) return JSON.stringify({ error: '权限不足：需要管理员权限' });
  pendingReload = true;
  return JSON.stringify({ success: true, message: '将在当前对话轮次结束后重载应用' });
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

// --- Memory management handlers ---

function handleSaveMemory(input: { content: string; scope?: string; category?: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '仅管理员可保存记忆' });
  const currentAgentId = getCurrentAgent()?.id;
  const result = saveMemoryFn({
    content: input.content,
    scope: (input.scope as 'global' | 'agent') ?? 'global',
    agentId: input.scope === 'agent' ? currentAgentId ?? undefined : undefined,
    category: input.category,
    source: 'manual',
  });
  return JSON.stringify(result);
}

function handleSearchMemory(input: { keyword: string }): string {
  const currentAgentId = getCurrentAgent()?.id;
  const items = searchMemoryFn(input.keyword, currentAgentId ?? undefined);
  return JSON.stringify(items);
}

function handleDeleteMemory(input: { id: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '仅管理员可删除记忆' });
  return JSON.stringify(deleteMemoryFn(input.id));
}

function handleUpdateMemory(input: { id: string; content?: string; category?: string }): string {
  if (!isAdmin()) return JSON.stringify({ error: '仅管理员可修改记忆' });
  return JSON.stringify(updateMemoryFn(input.id, { content: input.content, category: input.category }));
}

// --- Agent management handlers ---

function handleListAgents(): string {
  const agents = getAllAgents();
  const globalTools = getGlobalTools();
  return JSON.stringify(agents.map(a => {
    const availableTools = getAgentTools(a, globalTools).map(t => t.name);
    return {
      name: a.name,
      displayName: a.displayName,
      description: a.description,
      toolsMode: a.toolsMode,
      availableToolsCount: availableTools.length,
      availableTools,
    };
  }));
}

function handleGetAgent(input: { name: string }): string {
  const agent = getAgent(input.name);
  const globalTools = getGlobalTools();
  const availableTools = getAgentTools(agent, globalTools).map(t => t.name);
  return JSON.stringify({
    ...agent,
    availableToolsCount: availableTools.length,
    availableTools,
  });
}

function handleListToolPresets(): string {
  return JSON.stringify(
    Object.entries(TOOL_PRESETS).map(([key, preset]) => ({
      preset: key,
      description: preset.description,
      toolCount: preset.tools.length,
      tools: preset.tools,
    }))
  );
}

async function handleHttpRequest(input: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<string> {
  const { default: axios } = await import('axios');
  const method = (input.method ?? 'GET').toUpperCase();
  const timeout = input.timeout ?? 10000;
  try {
    const resp = await axios.request({
      url: input.url,
      method,
      headers: input.headers,
      data: input.body,
      timeout,
      responseType: 'text',
      transformResponse: [(data) => data],
      validateStatus: () => true,
    });
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    const truncated = body.length > 8000 ? body.slice(0, 8000) + `\n...(已截断，原始长度 ${body.length} 字节)` : body;
    return JSON.stringify({ status: resp.status, headers: resp.headers, body: truncated });
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

function handleSaveAgent(input: {
  name: string;
  display_name: string;
  description?: string;
  system_prompt?: string;
  model?: string;
  provider?: string;
  tools_mode?: string;
  tools_list?: string[];
  max_history?: number;
  preset?: string;
}): string {
  if (input.preset) {
    const preset = TOOL_PRESETS[input.preset];
    if (!preset) return JSON.stringify({ error: `未知 preset: ${input.preset}，可用: ${Object.keys(TOOL_PRESETS).join(', ')}` });
    input.tools_mode = input.tools_mode || 'allowlist';
    input.tools_list = preset.tools;
  }
  const result = saveAgent({
    name: input.name,
    displayName: input.display_name,
    description: input.description,
    systemPrompt: input.system_prompt,
    model: input.model,
    provider: input.provider,
    toolsMode: input.tools_mode as any,
    toolsList: input.tools_list,
    maxHistory: input.max_history,
  });
  return JSON.stringify(result);
}

function handleDeleteAgent(input: { name: string }): string {
  return JSON.stringify(deleteAgent(input.name));
}

function handleSwitchAgent(input: { name: string }): string {
  const agent = getAgent(input.name);
  if (agent.name !== input.name && input.name !== 'otcclaw') {
    return JSON.stringify({ error: `未找到 Agent: ${input.name}` });
  }
  return JSON.stringify({ success: true, message: `已切换到 Agent: ${agent.displayName} (${agent.name})` });
}

function handleAssignAgent(input: { agent_name: string; channel: string; target_id?: string }): string {
  const result = saveAssignment(input.agent_name, input.channel, undefined, input.target_id);
  return JSON.stringify(result);
}

function handleUnassignAgent(input: { channel: string; target_id?: string }): string {
  const result = deleteAssignment(input.channel, undefined, input.target_id);
  return JSON.stringify(result);
}

function handleListAssignments(): string {
  const assignments = listAssignments();
  return JSON.stringify(assignments);
}


export async function executeTool(name: string, input: any): Promise<string> {
  switch (name) {
    case 'query_clients': return handleQueryClients(input);
    case 'view_client': return handleViewClient(input);
    case 'get_client_history': return handleGetHistory(input);
    case 'get_status_summary': return handleStatusSummary();
    case 'search_knowledge': return handleSearchKnowledge(input);
    case 'update_knowledge': return handleUpdateKnowledge(input);
    case 'assign_knowledge_agent': return handleAssignKnowledgeAgent(input);
    case 'unassign_knowledge_agent': return handleUnassignKnowledgeAgent(input);
    case 'get_knowledge_agents': return handleGetKnowledgeAgents(input);
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
    case 'edit_file': return handleEditFile(input);
    case 'reload_app': return handleReloadApp();
    case 'extract_wework_qa': return handleExtractWeworkQA(input);
    case 'list_agents': return handleListAgents();
    case 'get_agent': return handleGetAgent(input);
    case 'save_agent': return handleSaveAgent(input);
    case 'delete_agent': return handleDeleteAgent(input);
    case 'switch_agent': return handleSwitchAgent(input);
    case 'assign_agent': return handleAssignAgent(input);
    case 'unassign_agent': return handleUnassignAgent(input);
    case 'list_agent_assignments': return handleListAssignments();
    case 'save_memory': return handleSaveMemory(input);
    case 'search_memory': return handleSearchMemory(input);
    case 'delete_memory': return handleDeleteMemory(input);
    case 'update_memory': return handleUpdateMemory(input);
    case 'list_tool_presets': return handleListToolPresets();
    case 'http_request': return handleHttpRequest(input);
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
let currentAgent: AgentConfig | undefined;

export function setCurrentAgent(agent: AgentConfig | undefined): void {
  currentAgent = agent;
}

export function getCurrentAgent(): AgentConfig | undefined {
  return currentAgent ?? getDefaultAgent();
}

/** All globally registered tools */
export function getGlobalTools(): Anthropic.Tool[] {
  return tools;
}

/** @deprecated Use getGlobalTools() + getAgentTools() instead */
export function getTools(): Anthropic.Tool[] {
  return tools;
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
  } = {}
): Promise<string> {
  const { streamEnabled = false, logPrefix = '', showThinking: showThinkingOpt = showThinking(), agentConfig, images, onProgress } = options;

  const agent = agentConfig;
  const maxHistory = agent?.maxHistory ?? MAX_HISTORY_MESSAGES;
  const activeTools = agent ? getAgentTools(agent, tools) : tools;
  const systemPrompt = agent ? buildSystemPrompt(agent, user) : getSystemPrompt(user);

  // 图片需要 vision 能力，选择支持 vision 的 provider
  // 优先级：anthropic（原生支持）→ openrouter（通过 Claude vision）
  let visionProvider: import('./provider.js').LLMProvider | undefined;
  let visionModel: string | undefined;
  if (images && images.length > 0) {
    const currentProv = getProviderName();
    if (currentProv === 'anthropic') {
      // 原生 Anthropic 直接支持 image block，无需切换
    } else {
      // 尝试 openrouter（支持 Claude vision 的 OpenAI 兼容接口）
      const openrouter = getProviderByName('openrouter');
      if (openrouter) {
        visionProvider = openrouter;
        visionModel = process.env.OPENROUTER_VISION_MODEL || 'anthropic/claude-sonnet-4';
        log.dim(`${logPrefix}📷 图片消息，临时使用 openrouter/${visionModel} 处理`);
      } else {
        // 回退到 anthropic
        const anthropic = getProviderByName('anthropic');
        if (anthropic) {
          visionProvider = anthropic;
          visionModel = anthropic.defaultModel;
          log.dim(`${logPrefix}📷 图片消息，临时使用 anthropic/${visionModel} 处理`);
        } else {
          log.warn(`${logPrefix}⚠️ 当前 provider 不支持图片，且无可用 vision provider`);
        }
      }
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
          result = await executeTool(block.name, block.input);
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
  if (pendingReload) {
    pendingReload = false;
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
 * 从用户输入中提取本地图片路径，返回 images 数组和去除路径后的文本
 */
function extractLocalImages(input: string): { text: string; images: ImageInput[] } {
  const images: ImageInput[] = [];
  const text = input.replace(IMAGE_PATH_RE, (match, filePath: string) => {
    // 展开 ~ 为 HOME 目录
    const resolved = filePath.startsWith('~/')
      ? path.join(process.env.HOME || '', filePath.slice(1))
      : path.resolve(filePath);
    try {
      if (!fs.existsSync(resolved)) return match; // 文件不存在，保留原文
      const buf = fs.readFileSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const mediaType: ImageInput['mediaType'] =
        ext === '.png' ? 'image/png'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : 'image/jpeg';
      images.push({ data: buf.toString('base64'), mediaType });
      return ''; // 从文本中移除路径
    } catch {
      return match;
    }
  }).trim();

  return { text: text || (images.length > 0 ? '请描述这张图片' : ''), images };
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
  currentAgent = undefined;
}
