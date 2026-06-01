import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'node:child_process';
import type {
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
  DeleteScheduledTaskInput,
  AddCrontabInput,
  RemoveCrontabInput,
} from '../llm/tool-types.js';
import { getCurrentAgent, type ToolContext, type DeliveryContext } from '../llm/agents/config.js';
import { getCurrentUser, isAgentAdmin } from '../auth/rbac.js';
import {
  createScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
} from '../commands/scheduled-task.js';

// ─── App-internal scheduled tasks ───────────────────────────

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'create_scheduled_task',
    description: '创建周期性定时任务。支持三种类型：(1) remind — 按 cron 周期推送提醒消息；(2) sandbox_exec — 按 cron 周期在沙箱中执行脚本；(3) tool_call — 按 cron 周期调用允许的系统工具。cron_expr 为标准 5 字段格式（分 时 日 月 周），如 "0 9 * * 1-5" 表示工作日每天 9 点。',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: '任务名称（方便识别）' },
        cron_expr: { type: 'string', description: '标准 5 字段 cron 表达式，如 "30 8 * * *"（每天 8:30）、"0 */2 * * *"（每 2 小时）' },
        task_type: { type: 'string', enum: ['remind', 'sandbox_exec', 'tool_call'], description: 'remind=周期提醒，sandbox_exec=周期执行脚本，tool_call=周期调用系统工具' },
        payload: { type: 'string', description: 'JSON 字符串。remind: {"message":"..."}, sandbox_exec: {"language":"python","code":"...","notify":true}, tool_call: {"tool_name":"calc_etf_trades","input":{},"notify":false}' },
        timezone: { type: 'string', description: '时区，默认 Asia/Shanghai' },
      },
      required: ['name', 'cron_expr', 'task_type', 'payload'],
    },
  },
  {
    name: 'list_scheduled_tasks',
    description: '列出当前 agent 所有定时任务（含状态、下次执行时间、上次结果）',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'update_scheduled_task',
    description: '修改定时任务（启用/禁用、改 cron 表达式、改名称、改 payload）',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '任务 ID 或 ID 前缀（通过 list_scheduled_tasks 获取）' },
        enabled: { type: 'boolean', description: '是否启用' },
        cron_expr: { type: 'string', description: '新的 cron 表达式' },
        name: { type: 'string', description: '新名称' },
        payload: { type: 'string', description: '新的 payload JSON' },
        timezone: { type: 'string', description: '时区' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_scheduled_task',
    description: '删除一个定时任务',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: '任务 ID 或 ID 前缀' },
      },
      required: ['id'],
    },
  },

  // ─── System crontab management ──────────────────────────

  {
    name: 'list_crontab',
    description: '列出当前 agent 通过 add_crontab 创建的 crontab 条目（需要 agent admin 权限）',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'add_crontab',
    description: '添加一条当前 agent 拥有的 crontab 条目（需要 agent admin 权限）。会自动写入 agent 归属元数据以便后续隔离管理。',
    input_schema: {
      type: 'object' as const,
      properties: {
        cron_expr: { type: 'string', description: '标准 5 字段 cron 表达式' },
        command: { type: 'string', description: '要执行的命令' },
        comment: { type: 'string', description: '注释标记（方便查找和删除），不提供则自动生成' },
      },
      required: ['cron_expr', 'command'],
    },
  },
  {
    name: 'remove_crontab',
    description: '按注释标记或命令内容匹配删除当前 agent 自己创建的 crontab 条目（需要 agent admin 权限）',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: '匹配关键词（会匹配注释行和命令行，包含此字符串的条目及其注释行将被删除）' },
      },
      required: ['pattern'],
    },
  },
];

// ─── Handlers: app-internal tasks ───────────────────────────

function handleCreateScheduledTask(input: CreateScheduledTaskInput, deliveryCtx?: DeliveryContext): string {
  if (!deliveryCtx) {
    return JSON.stringify({ error: '无法创建定时任务：缺少投递上下文。请通过飞书、Telegram 或企微渠道使用此功能。' });
  }
  const agentId = getCurrentAgent()?.id ?? 'default';
  let createdBy: string | undefined;
  try { createdBy = getCurrentUser().id; } catch { /* user context may be unavailable in tests */ }
  const result = createScheduledTask({
    agentId,
    name: input.name,
    cronExpr: input.cron_expr,
    taskType: input.task_type,
    payload: input.payload,
    channel: deliveryCtx.channel,
    targetId: deliveryCtx.targetId,
    appId: deliveryCtx.appId,
    createdBy,
    timezone: input.timezone,
  });
  if (!result.success) return JSON.stringify(result);
  const readableTime = new Date(result.next_run_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return JSON.stringify({ ...result, next_run_at_readable: readableTime });
}

function handleListScheduledTasks(): string {
  const agentId = getCurrentAgent()?.id ?? 'default';
  const items = listScheduledTasks(agentId);
  if (items.length === 0) return JSON.stringify({ message: '暂无定时任务' });
  return JSON.stringify(items.map(t => ({
    id: t.id.slice(0, 8),
    name: t.name,
    cron_expr: t.cron_expr,
    task_type: t.task_type,
    enabled: !!t.enabled,
    next_run_at: t.next_run_at ? new Date(t.next_run_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : null,
    last_run_at: t.last_run_at ? new Date(t.last_run_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : null,
    last_result: t.last_result ? t.last_result.slice(0, 200) : null,
    channel: t.channel,
  })));
}

function handleUpdateScheduledTask(input: UpdateScheduledTaskInput): string {
  const agentId = getCurrentAgent()?.id ?? 'default';
  return JSON.stringify(updateScheduledTask(input.id, agentId, {
    enabled: input.enabled,
    cronExpr: input.cron_expr,
    name: input.name,
    payload: input.payload,
    timezone: input.timezone,
  }));
}

function handleDeleteScheduledTask(input: DeleteScheduledTaskInput): string {
  const agentId = getCurrentAgent()?.id ?? 'default';
  return JSON.stringify(deleteScheduledTask(input.id, agentId));
}

// ─── Handlers: agent-owned crontab ──────────────────────────

export interface AgentCrontabEntry {
  comment?: string;
  schedule?: string;
  command?: string;
  raw: string;
}

interface ParsedCrontabEntry extends AgentCrontabEntry {
  ownerAgentId?: string;
  ownerAgentName?: string;
  startLine: number;
  endLine: number;
}

interface CrontabOwnerMeta {
  agentId: string;
  agentName?: string;
  comment?: string;
}

const CRONTAB_OWNER_PREFIX = 'samata-agent-crontab';
const CRON_LINE_RE = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/;

function encodeMetadataValue(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function decodeMetadataValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return Buffer.from(value, 'base64url').toString('utf-8');
  } catch {
    return undefined;
  }
}

export function formatAgentCrontabMarker(agent: { id: string; name: string }, comment: string): string {
  return [
    `# ${CRONTAB_OWNER_PREFIX}`,
    `agent_id=${encodeMetadataValue(agent.id)}`,
    `agent_name=${encodeMetadataValue(agent.name)}`,
    `comment=${encodeMetadataValue(comment)}`,
  ].join(' ');
}

function parseOwnerMarker(line: string): CrontabOwnerMeta | null {
  const text = line.trim().replace(/^#\s*/, '');
  if (!text.startsWith(CRONTAB_OWNER_PREFIX)) return null;

  const fields = new Map<string, string>();
  for (const part of text.slice(CRONTAB_OWNER_PREFIX.length).trim().split(/\s+/)) {
    const [key, value] = part.split('=');
    if (key && value) fields.set(key, value);
  }

  const agentId = decodeMetadataValue(fields.get('agent_id'));
  if (!agentId) return null;

  return {
    agentId,
    agentName: decodeMetadataValue(fields.get('agent_name')),
    comment: decodeMetadataValue(fields.get('comment')),
  };
}

function parseCrontabEntries(raw: string): ParsedCrontabEntry[] {
  const lines = raw.split(/\r?\n/);
  const entries: ParsedCrontabEntry[] = [];
  let pendingCommentLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      pendingCommentLines = [];
      continue;
    }

    if (trimmed.startsWith('#')) {
      pendingCommentLines.push(i);
      continue;
    }

    const match = line.match(CRON_LINE_RE);
    if (!match) {
      pendingCommentLines = [];
      continue;
    }

    let owner: CrontabOwnerMeta | null = null;
    let markerLine = -1;
    const plainComments: string[] = [];
    for (const commentLine of pendingCommentLines) {
      const marker = parseOwnerMarker(lines[commentLine]);
      if (marker) {
        owner = marker;
        markerLine = commentLine;
      } else {
        plainComments.push(lines[commentLine].trim().replace(/^#\s*/, ''));
      }
    }

    entries.push({
      comment: owner?.comment ?? plainComments.at(-1),
      schedule: match[1],
      command: match[2],
      raw: line,
      ownerAgentId: owner?.agentId,
      ownerAgentName: owner?.agentName,
      startLine: markerLine >= 0 ? markerLine : i,
      endLine: i,
    });
    pendingCommentLines = [];
  }

  return entries;
}

export function listOwnedCrontabEntries(raw: string, agentId: string): AgentCrontabEntry[] {
  return parseCrontabEntries(raw)
    .filter(entry => entry.ownerAgentId === agentId)
    .map(({ comment, schedule, command, raw }) => ({ comment, schedule, command, raw }));
}

export function removeOwnedCrontabEntries(raw: string, agentId: string, pattern: string): { updated: string; removed: number } {
  const needle = pattern.trim();
  if (!needle) return { updated: raw, removed: 0 };

  const lines = raw.split(/\r?\n/);
  const removeLines = new Set<number>();
  let removed = 0;

  for (const entry of parseCrontabEntries(raw)) {
    if (entry.ownerAgentId !== agentId) continue;
    const haystack = [entry.comment, entry.schedule, entry.command, entry.raw]
      .filter((value): value is string => !!value);
    if (!haystack.some(value => value.includes(needle))) continue;

    for (let i = entry.startLine; i <= entry.endLine; i++) {
      removeLines.add(i);
    }
    removed++;
  }

  if (removed === 0) return { updated: raw, removed };

  const updated = lines
    .filter((_, index) => !removeLines.has(index))
    .join('\n')
    .trimEnd();
  return { updated: updated ? `${updated}\n` : '', removed };
}

function readCrontab(): string {
  return execFileSync('crontab', ['-l'], {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function writeCrontab(content: string): void {
  execFileSync('crontab', ['-'], {
    input: content,
    encoding: 'utf-8',
    timeout: 5000,
  });
}

function rejectMultiline(field: string, value: string | undefined): string | null {
  if (value && /[\r\n]/.test(value)) return `${field} 不能包含换行`;
  return null;
}

function requireAgentAdmin(): string | null {
  const agent = getCurrentAgent();
  if (!agent) return JSON.stringify({ error: '无法确定当前 agent' });
  if (!isAgentAdmin(agent.id)) return JSON.stringify({ error: '需要 agent admin 权限才能管理当前 agent 的 crontab' });
  return null;
}

function handleListCrontab(): string {
  const denied = requireAgentAdmin();
  if (denied) return denied;

  const agent = getCurrentAgent();
  if (!agent) return JSON.stringify({ error: '无法确定当前 agent' });

  try {
    const entries = listOwnedCrontabEntries(readCrontab(), agent.id);
    return JSON.stringify({ count: entries.length, entries });
  } catch {
    return JSON.stringify({ count: 0, entries: [], message: 'crontab 为空或不可访问' });
  }
}

function handleAddCrontab(input: AddCrontabInput): string {
  const denied = requireAgentAdmin();
  if (denied) return denied;

  const agent = getCurrentAgent();
  if (!agent) return JSON.stringify({ success: false, error: '无法确定当前 agent' });

  for (const [field, value] of Object.entries({
    cron_expr: input.cron_expr,
    command: input.command,
    comment: input.comment,
  })) {
    const error = rejectMultiline(field, value);
    if (error) return JSON.stringify({ success: false, error });
  }

  const comment = input.comment?.trim() || `samata-${Date.now()}`;
  const newLine = `${input.cron_expr} ${input.command}`;

  try {
    let existing = '';
    try { existing = readCrontab(); } catch { /* empty crontab */ }

    const current = existing.trimEnd();
    const updated = `${current ? `${current}\n` : ''}${formatAgentCrontabMarker(agent, comment)}\n${newLine}\n`;
    writeCrontab(updated);
    return JSON.stringify({ success: true, comment, entry: newLine });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

function handleRemoveCrontab(input: RemoveCrontabInput): string {
  const denied = requireAgentAdmin();
  if (denied) return denied;

  const agent = getCurrentAgent();
  if (!agent) return JSON.stringify({ success: false, error: '无法确定当前 agent' });
  if (!input.pattern?.trim()) return JSON.stringify({ success: false, error: 'pattern 不能为空' });

  try {
    let existing = '';
    try { existing = readCrontab(); } catch {
      return JSON.stringify({ success: false, error: 'crontab 为空' });
    }

    const { updated, removed } = removeOwnedCrontabEntries(existing, agent.id, input.pattern);
    if (removed === 0) return JSON.stringify({ success: false, error: `未找到当前 agent 创建且匹配 "${input.pattern}" 的条目` });

    writeCrontab(updated);
    return JSON.stringify({ success: true, removed });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
}

// ─── Dispatch ────────────────────────────────────────────────

export async function handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'create_scheduled_task': return handleCreateScheduledTask(input, ctx?.deliveryContext);
    case 'list_scheduled_tasks': return handleListScheduledTasks();
    case 'update_scheduled_task': return handleUpdateScheduledTask(input);
    case 'delete_scheduled_task': return handleDeleteScheduledTask(input);
    case 'list_crontab': return handleListCrontab();
    case 'add_crontab': return handleAddCrontab(input);
    case 'remove_crontab': return handleRemoveCrontab(input);
    default: return null;
  }
}
