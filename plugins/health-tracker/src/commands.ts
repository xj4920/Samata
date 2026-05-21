import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';

export interface HealthRecord {
  id: string;
  user_id: string;
  agent_id: string;
  record_type: string;
  value: string;
  unit: string | null;
  measured_at: string;
  notes: string | null;
  created_at: string;
}

export function addHealthRecord(
  db: Database.Database,
  userId: string,
  agentId: string,
  recordType: string,
  value: string,
  unit?: string,
  measuredAt?: string,
  notes?: string,
): { success: boolean; id: string } {
  const id = uuid();
  const at = measuredAt || new Date().toISOString();
  db.prepare(
    'INSERT INTO health_records (id, user_id, agent_id, record_type, value, unit, measured_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, userId, agentId, recordType, value, unit ?? null, at, notes ?? null);
  return { success: true, id: id.slice(0, 8) };
}

export function queryHealthRecords(
  db: Database.Database,
  userId: string,
  agentId: string,
  recordType?: string,
  startDate?: string,
  endDate?: string,
  limit = 20,
): HealthRecord[] {
  const params: any[] = [userId, agentId];
  let sql = 'SELECT * FROM health_records WHERE user_id = ? AND agent_id = ?';
  if (recordType) { sql += ' AND record_type = ?'; params.push(recordType); }
  if (startDate) { sql += ' AND measured_at >= ?'; params.push(startDate); }
  if (endDate) { sql += ' AND measured_at <= ?'; params.push(endDate + 'T23:59:59'); }
  sql += ' ORDER BY measured_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as HealthRecord[];
}

export function getHealthSummary(db: Database.Database, userId: string, agentId: string): Record<string, HealthRecord[]> {
  const types = (
    db.prepare('SELECT DISTINCT record_type FROM health_records WHERE user_id = ? AND agent_id = ?').all(userId, agentId) as { record_type: string }[]
  ).map(r => r.record_type);

  const result: Record<string, HealthRecord[]> = {};
  for (const type of types) {
    result[type] = db
      .prepare('SELECT * FROM health_records WHERE user_id = ? AND agent_id = ? AND record_type = ? ORDER BY measured_at DESC LIMIT 3')
      .all(userId, agentId, type) as HealthRecord[];
  }
  return result;
}
