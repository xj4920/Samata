import { getDb } from '../db/connection.js';
import { v4 as uuid } from 'uuid';
import { CronExpressionParser } from 'cron-parser';

export interface ScheduledTask {
  id: string;
  agent_id: string;
  name: string;
  cron_expr: string;
  task_type: 'remind' | 'sandbox_exec';
  payload: string;
  channel: string;
  target_id: string | null;
  app_id: string | null;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_result: string | null;
  created_at: number;
  created_by: string | null;
}

const MAX_TASKS_PER_AGENT = 50;

export function computeNextRun(cronExpr: string, tz = 'Asia/Shanghai'): number {
  const expr = CronExpressionParser.parse(cronExpr, { tz });
  return expr.next().getTime();
}

export function createScheduledTask(input: {
  agentId: string;
  name: string;
  cronExpr: string;
  taskType: 'remind' | 'sandbox_exec';
  payload: string;
  channel: string;
  targetId?: string;
  appId?: string;
  createdBy?: string;
  timezone?: string;
}): { success: true; id: string; next_run_at: number } | { success: false; error: string } {
  const db = getDb();

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

  // Validate payload JSON
  try {
    JSON.parse(input.payload);
  } catch {
    return { success: false, error: 'payload 必须是合法的 JSON 字符串' };
  }

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
    'SELECT id, cron_expr FROM scheduled_tasks WHERE id LIKE ? AND agent_id = ?'
  ).get(idPrefix + '%', agentId) as { id: string; cron_expr: string } | undefined;

  if (!row) return { success: false, error: `未找到任务: ${idPrefix}` };

  const sets: string[] = [];
  const vals: any[] = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.payload !== undefined) {
    try { JSON.parse(patch.payload); } catch { return { success: false, error: 'payload 必须是合法的 JSON' }; }
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
  ).get(idPrefix + '%', agentId) as { id: string } | undefined;

  if (!row) return { success: false, error: `未找到任务: ${idPrefix}` };

  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(row.id);
  return { success: true };
}

export function getDueScheduledTasks(): ScheduledTask[] {
  return getDb().prepare(
    'SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ?'
  ).all(Date.now()) as ScheduledTask[];
}

export function markTaskExecuted(id: string, result: string | null, nextRunAt: number): void {
  getDb().prepare(
    'UPDATE scheduled_tasks SET last_run_at = ?, last_result = ?, next_run_at = ? WHERE id = ?'
  ).run(Date.now(), result, nextRunAt, id);
}
