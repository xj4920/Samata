import { getDb } from '../db/connection.js';
import { v4 as uuid } from 'uuid';

export interface Reminder {
  id: string;
  agent_id: string;
  message: string;
  remind_at: number;   // Unix timestamp ms
  status: 'pending' | 'delivered' | 'cancelled';
  channel: string;
  target_id: string;
  app_id: string | null;
  created_at: number;
}

export function createReminder(input: {
  agentId: string;
  message: string;
  remindAt: number;
  channel: string;
  targetId?: string;
  appId?: string;
}): { success: true; id: string } | { success: false; error: string } {
  const db = getDb();
  const id = uuid();
  db.prepare(
    `INSERT INTO reminders (id, agent_id, message, remind_at, status, channel, target_id, app_id, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(id, input.agentId, input.message, input.remindAt, input.channel, input.targetId ?? null, input.appId ?? null, Date.now());
  return { success: true, id: id.slice(0, 8) };
}

export function listReminders(agentId: string): Reminder[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM reminders WHERE agent_id = ? AND status = 'pending' ORDER BY remind_at ASC`
  ).all(agentId) as Reminder[];
}

export function cancelReminder(idPrefix: string, agentId: string): { success: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM reminders WHERE id LIKE ? AND agent_id = ? AND status = 'pending'`
  ).get(idPrefix + '%', agentId) as { id: string } | undefined;
  if (!row) return { success: false, error: `未找到待触发的提醒: ${idPrefix}` };
  db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ?`).run(row.id);
  return { success: true };
}

export function getPendingReminders(): Reminder[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= ?`
  ).all(Date.now()) as Reminder[];
}

export function markDelivered(id: string): void {
  getDb().prepare(`UPDATE reminders SET status = 'delivered' WHERE id = ?`).run(id);
}
