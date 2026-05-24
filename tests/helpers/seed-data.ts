import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

/**
 * Insert test seed data into the in-memory DB.
 * Called after initSchema() so all tables + default agents already exist.
 */
export function seedTestData(db: Database.Database) {
  seedClients(db);
  seedHealthRecords(db);
  seedTodos(db);
}

function seedClients(db: Database.Database) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO clients (id, name, contact, state, wework_group, requirements, tags, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin-001')
  `);
  ins.run('client-kuande', '宽德', '张三', 'prod', '宽德-广发对接群', '北上极速通道', '["北上","极速"]', '活跃客户');
  ins.run('client-jump', 'Jump', 'John', 'uat', 'Jump&GF系统连接群', 'FIX 接入', '["FIX","极速"]', 'UAT 测试中');
  ins.run('client-jinde', 'Jinde', '李四', 'prod', 'Jinde-广发股衍香港IT对接', 'OTC 衍生品', '["OTC"]', null);
}

function seedHealthRecords(db: Database.Database) {
  const agentId = db.prepare("SELECT id FROM agents WHERE name='doctor'").get() as { id: string } | undefined;
  if (!agentId) return;

  const ins = db.prepare(`
    INSERT INTO health_records (id, user_id, agent_id, record_type, value, unit, measured_at, notes)
    VALUES (?, 'admin-001', ?, ?, ?, ?, ?, ?)
  `);
  const aid = agentId.id;
  ins.run(uuid(), aid, 'sleep', JSON.stringify({ duration_hours: 7.5, quality: 'good', bedtime: '23:00', wake_time: '06:30' }), null, '2026-05-21', '睡眠质量良好');
  ins.run(uuid(), aid, 'sleep', JSON.stringify({ duration_hours: 6.0, quality: 'poor', bedtime: '01:00', wake_time: '07:00' }), null, '2026-05-20', '入睡困难');
  ins.run(uuid(), aid, 'blood_pressure', JSON.stringify({ systolic: 120, diastolic: 80 }), 'mmHg', '2026-05-19', null);
  ins.run(uuid(), aid, 'symptom', JSON.stringify({ description: '头痛', severity: 'mild' }), null, '2026-05-18', '偶发性头痛');
}

function seedTodos(db: Database.Database) {
  const agentId = db.prepare("SELECT id FROM agents WHERE name='alter-ego'").get() as { id: string } | undefined;
  if (!agentId) return;

  const ins = db.prepare(`
    INSERT INTO todos (id, agent_id, user_id, title, description, status, priority, due_date)
    VALUES (?, ?, 'admin-001', ?, ?, ?, ?, ?)
  `);
  const aid = agentId.id;
  ins.run(uuid(), aid, '完成季度报告', '整理Q2交易数据', 'pending', 'high', '2026-05-30');
  ins.run(uuid(), aid, '预约体检', '年度体检预约', 'pending', 'normal', '2026-06-15');
  ins.run(uuid(), aid, '阅读《系统设计》', '第3-5章', 'in_progress', 'low', null);
}
