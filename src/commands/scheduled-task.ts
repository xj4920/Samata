import { getDb } from '../db/connection.js';
import { v4 as uuid } from 'uuid';
import { CronExpressionParser } from 'cron-parser';
import { isToolDisabled } from '../runtime/tool-policy.js';

export interface ScheduledTask {
  id: string;
  agent_id: string;
  name: string;
  cron_expr: string;
  task_type: ScheduledTaskType;
  payload: string;
  channel: string;
  target_id: string | null;
  app_id: string | null;
  enabled: number;
  next_run_at: number | null;
  locked_until: number | null;
  last_run_at: number | null;
  last_result: string | null;
  created_at: number;
  created_by: string | null;
}

export type ScheduledTaskType = 'remind' | 'sandbox_exec' | 'tool_call' | 'agent_chat';

const MAX_TASKS_PER_AGENT = 50;
const TASK_TYPES = new Set<ScheduledTaskType>(['remind', 'sandbox_exec', 'tool_call', 'agent_chat']);
const TOOL_CALL_ALLOWLIST = new Set([
  'calc_etf_trades',
  'sync_fast_trading_summary',
  'sync_normal_trading_summary',
]);

export function computeNextRun(cronExpr: string, tz = 'Asia/Shanghai'): number {
  const expr = CronExpressionParser.parse(cronExpr, { tz });
  return expr.next().getTime();
}

function validatePayload(taskType: ScheduledTaskType, payload: string): { ok: true } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, error: 'payload 必须是合法的 JSON 字符串' };
  }

  if (taskType === 'agent_chat') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'agent_chat payload 必须是 JSON 对象' };
    }
    const obj = parsed as Record<string, unknown>;
    const prompt = typeof obj.prompt === 'string'
      ? obj.prompt
      : typeof obj.message === 'string'
      ? obj.message
      : '';
    if (!prompt.trim()) {
      return { ok: false, error: 'agent_chat payload 必须包含非空 prompt 字符串' };
    }
    const invalidKeys = Object.keys(obj).filter((key) => !['prompt', 'message'].includes(key));
    if (invalidKeys.length > 0) {
      return { ok: false, error: `agent_chat payload 不支持字段: ${invalidKeys.join(', ')}` };
    }
    return { ok: true };
  }

  if (taskType !== 'tool_call') return { ok: true };

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'tool_call payload 必须是 JSON 对象' };
  }

  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const expectedKeys = ['input', 'notify', 'tool_name'];
  if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
    return { ok: false, error: 'tool_call payload 必须为 {"tool_name":"<allowed>","input":{},"notify":false}' };
  }
  if (typeof obj.tool_name !== 'string' || !TOOL_CALL_ALLOWLIST.has(obj.tool_name)) {
    return { ok: false, error: `tool_call 仅支持: ${[...TOOL_CALL_ALLOWLIST].join(', ')}` };
  }
  if (isToolDisabled(obj.tool_name)) {
    return { ok: false, error: `工具已被运行环境禁用: ${obj.tool_name}` };
  }
  if (!obj.input || typeof obj.input !== 'object' || Array.isArray(obj.input)) {
    return { ok: false, error: 'tool_call input 必须是 JSON 对象' };
  }
  const input = obj.input as Record<string, unknown>;
  if (obj.notify !== false) {
    return { ok: false, error: 'tool_call notify 必须为 false' };
  }

  return validateToolCallInput(obj.tool_name, input);
}

function validateToolCallInput(toolName: string, input: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  if (toolName === 'calc_etf_trades') {
    const inputKeys = Object.keys(input);
    if (inputKeys.length > 1 || (inputKeys.length === 1 && inputKeys[0] !== 'force')) {
      return { ok: false, error: 'calc_etf_trades input 仅支持 {} 或 {"force":true}' };
    }
    if ('force' in input && typeof input.force !== 'boolean') {
      return { ok: false, error: 'calc_etf_trades input.force 必须是 boolean' };
    }
    return { ok: true };
  }

  if (toolName === 'sync_fast_trading_summary' || toolName === 'sync_normal_trading_summary') {
    const allowedKeys = new Set(['date_from', 'date_to', 'force', 'keep_raw']);
    const invalidKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
    if (invalidKeys.length > 0) {
      return { ok: false, error: `${toolName} input 不支持字段: ${invalidKeys.join(', ')}` };
    }
    for (const key of ['date_from', 'date_to']) {
      if (key in input && typeof input[key] !== 'string') {
        return { ok: false, error: `${toolName} input.${key} 必须是 string` };
      }
    }
    for (const key of ['force', 'keep_raw']) {
      if (key in input && typeof input[key] !== 'boolean') {
        return { ok: false, error: `${toolName} input.${key} 必须是 boolean` };
      }
    }
    return { ok: true };
  }

  return { ok: false, error: `tool_call 仅支持: ${[...TOOL_CALL_ALLOWLIST].join(', ')}` };
}

export function createScheduledTask(input: {
  agentId: string;
  name: string;
  cronExpr: string;
  taskType: ScheduledTaskType;
  payload: string;
  channel: string;
  targetId?: string;
  appId?: string;
  createdBy?: string;
  timezone?: string;
}): { success: true; id: string; next_run_at: number } | { success: false; error: string } {
  const db = getDb();

  if (!TASK_TYPES.has(input.taskType)) {
    return { success: false, error: `无效的任务类型: ${input.taskType}` };
  }

  // Validate cron expression
  try {
    CronExpressionParser.parse(input.cronExpr);
  } catch {
    return { success: false, error: `无效的 cron 表达式: ${input.cronExpr}` };
  }

  // Enforce per-agent limit
  const count = db.prepare(
    'SELECT COUNT(*) as c FROM scheduled_tasks WHERE agent_id = ?'
  ).get(input.agentId) as { c: number };
  if (count.c >= MAX_TASKS_PER_AGENT) {
    return { success: false, error: `已达上限（${MAX_TASKS_PER_AGENT} 条），请先删除不需要的任务` };
  }

  const payloadValidation = validatePayload(input.taskType, input.payload);
  if (!payloadValidation.ok) return { success: false, error: payloadValidation.error };

  const id = uuid();
  const nextRun = computeNextRun(input.cronExpr, input.timezone);

  db.prepare(
    `INSERT INTO scheduled_tasks (id, agent_id, name, cron_expr, task_type, payload, channel, target_id, app_id, next_run_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.agentId, input.name, input.cronExpr, input.taskType,
    input.payload, input.channel, input.targetId ?? null, input.appId ?? null,
    nextRun, input.createdBy ?? null,
  );

  return { success: true, id: id.slice(0, 8), next_run_at: nextRun };
}

export function listScheduledTasks(agentId: string): ScheduledTask[] {
  return getDb().prepare(
    'SELECT * FROM scheduled_tasks WHERE agent_id = ? ORDER BY created_at DESC'
  ).all(agentId) as ScheduledTask[];
}

export function updateScheduledTask(
  idPrefix: string,
  agentId: string,
  patch: { enabled?: boolean; cronExpr?: string; name?: string; payload?: string; timezone?: string },
): { success: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, cron_expr, task_type FROM scheduled_tasks WHERE id LIKE ? AND agent_id = ?'
  ).get(idPrefix + '%', agentId) as Pick<ScheduledTask, 'id' | 'cron_expr' | 'task_type'> | undefined;

  if (!row) return { success: false, error: `未找到任务: ${idPrefix}` };

  const sets: string[] = [];
  const vals: any[] = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.payload !== undefined) {
    const payloadValidation = validatePayload(row.task_type, patch.payload);
    if (!payloadValidation.ok) return { success: false, error: payloadValidation.error };
    sets.push('payload = ?');
    vals.push(patch.payload);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    vals.push(patch.enabled ? 1 : 0);
  }

  let cronExpr = row.cron_expr;
  if (patch.cronExpr !== undefined) {
    try { CronExpressionParser.parse(patch.cronExpr); } catch { return { success: false, error: `无效的 cron 表达式: ${patch.cronExpr}` }; }
    sets.push('cron_expr = ?');
    vals.push(patch.cronExpr);
    cronExpr = patch.cronExpr;
  }

  // Recompute next_run_at if cron or enabled changed
  if (patch.cronExpr !== undefined || patch.enabled !== undefined) {
    const enabled = patch.enabled !== undefined ? patch.enabled : true;
    if (enabled) {
      const next = computeNextRun(cronExpr, patch.timezone);
      sets.push('next_run_at = ?');
      vals.push(next);
    }
  }

  if (sets.length === 0) return { success: false, error: '没有需要更新的字段' };

  vals.push(row.id);
  db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { success: true };
}

export function deleteScheduledTask(idPrefix: string, agentId: string): { success: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare(
    'SELECT id FROM scheduled_tasks WHERE id LIKE ? AND agent_id = ?'
  ).get(idPrefix + '%', agentId) as Pick<ScheduledTask, 'id'> | undefined;

  if (!row) return { success: false, error: `未找到任务: ${idPrefix}` };

  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(row.id);
  return { success: true };
}

export function getDueScheduledTasks(): ScheduledTask[] {
  const now = Date.now();
  return getDb().prepare(
    `SELECT * FROM scheduled_tasks
     WHERE enabled = 1
       AND next_run_at <= ?
       AND (locked_until IS NULL OR locked_until <= ?)`
  ).all(now, now) as ScheduledTask[];
}

export function claimDueScheduledTask(id: string, lockMs: number, now = Date.now()): ScheduledTask | null {
  const db = getDb();
  const lockedUntil = now + Math.max(1, lockMs);
  const result = db.prepare(
    `UPDATE scheduled_tasks
     SET locked_until = ?
     WHERE id = ?
       AND enabled = 1
       AND next_run_at <= ?
       AND (locked_until IS NULL OR locked_until <= ?)`
  ).run(lockedUntil, id, now, now);
  if (result.changes === 0) return null;
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask;
}

export function markTaskExecuted(id: string, result: string | null, nextRunAt: number): void {
  getDb().prepare(
    'UPDATE scheduled_tasks SET last_run_at = ?, last_result = ?, next_run_at = ?, locked_until = NULL WHERE id = ?'
  ).run(Date.now(), result, nextRunAt, id);
}
