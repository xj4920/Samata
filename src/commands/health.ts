import { getDb } from '../db/connection.js';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function getHealthFilesDir(): string {
  const envDir = process.env.HEALTH_FILES_DIR;
  if (envDir) return envDir.replace(/^~/, os.homedir());
  return path.join(os.homedir(), 'Documents', 'my', 'XBase', 'health');
}

function resolvePath(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

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

export interface HealthFile {
  id: string;
  user_id: string;
  agent_id: string;
  file_path: string;
  doc_type: string;
  measured_at: string;
  notes: string | null;
  created_at: string;
}

export function addHealthRecord(
  userId: string,
  agentId: string,
  recordType: string,
  value: string,
  unit?: string,
  measuredAt?: string,
  notes?: string,
): { success: boolean; id: string } {
  const db = getDb();
  const id = uuid();
  const at = measuredAt || new Date().toISOString();
  db.prepare(
    'INSERT INTO health_records (id, user_id, agent_id, record_type, value, unit, measured_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, userId, agentId, recordType, value, unit ?? null, at, notes ?? null);
  return { success: true, id: id.slice(0, 8) };
}

export function queryHealthRecords(
  userId: string,
  agentId: string,
  recordType?: string,
  startDate?: string,
  endDate?: string,
  limit = 20,
): HealthRecord[] {
  const db = getDb();
  const params: any[] = [userId, agentId];
  let sql = 'SELECT * FROM health_records WHERE user_id = ? AND agent_id = ?';
  if (recordType) { sql += ' AND record_type = ?'; params.push(recordType); }
  if (startDate) { sql += ' AND measured_at >= ?'; params.push(startDate); }
  if (endDate) { sql += ' AND measured_at <= ?'; params.push(endDate + 'T23:59:59'); }
  sql += ' ORDER BY measured_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as HealthRecord[];
}

export function getHealthSummary(userId: string, agentId: string): Record<string, HealthRecord[]> {
  const db = getDb();
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

export function archiveHealthFile(
  userId: string,
  agentId: string,
  srcPath: string,
  docType: string,
  measuredAt?: string,
  notes?: string,
): { success: boolean; id: string; path: string } | { success: false; error: string } {
  const resolved = resolvePath(srcPath);
  if (!fs.existsSync(resolved)) {
    return { success: false, error: `文件不存在: ${srcPath}` };
  }

  const dir = getHealthFilesDir();
  const now = measuredAt ? new Date(measuredAt) : new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthDir = path.join(dir, userId, month);
  fs.mkdirSync(monthDir, { recursive: true });

  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destName = `${timestamp}_${path.basename(resolved)}`;
  const destPath = path.join(monthDir, destName);
  fs.copyFileSync(resolved, destPath);

  const db = getDb();
  const id = uuid();
  db.prepare(
    'INSERT INTO health_files (id, user_id, agent_id, file_path, doc_type, measured_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, userId, agentId, destPath, docType, measuredAt || now.toISOString(), notes ?? null);

  return { success: true, id: id.slice(0, 8), path: destPath };
}

export function listHealthFiles(
  userId: string,
  agentId: string,
  docType?: string,
  limit = 20,
): HealthFile[] {
  const db = getDb();
  const params: any[] = [userId, agentId];
  let sql = 'SELECT * FROM health_files WHERE user_id = ? AND agent_id = ?';
  if (docType) { sql += ' AND doc_type = ?'; params.push(docType); }
  sql += ' ORDER BY measured_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as HealthFile[];
}

export function getHealthFile(idPrefix: string, userId: string): HealthFile | null {
  const db = getDb();
  return db
    .prepare("SELECT * FROM health_files WHERE (id = ? OR id LIKE ?) AND user_id = ? LIMIT 1")
    .get(idPrefix, idPrefix + '%', userId) as HealthFile | null;
}
