import { getDb } from '../db/connection.js';
import { getCurrentUser } from '../auth/rbac.js';
import { v4 as uuid } from 'uuid';

export interface AuditEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  payload: string | null;
  performed_by: string;
  created_at: string;
}

export function recordEvent(entityType: string, entityId: string, action: string, payload?: Record<string, any>): void {
  const db = getDb();
  const user = getCurrentUser();
  db.prepare(
    'INSERT INTO events (id, entity_type, entity_id, action, payload, performed_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(uuid(), entityType, entityId, action, payload ? JSON.stringify(payload) : null, user.id);
}

export function getEvents(entityId: string): AuditEvent[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM events WHERE entity_id = ? ORDER BY created_at ASC'
  ).all(entityId) as AuditEvent[];
}
