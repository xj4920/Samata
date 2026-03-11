import { getDb } from './connection.js';

export function initSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE,
      role       TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      contact      TEXT,
      state        TEXT NOT NULL DEFAULT 'initial_contact'
                   CHECK(state IN (
                     'initial_contact',
                     'requirement_discussion',
                     'solution_design',
                     'uat',
                     'prod'
                   )),
      wework_group TEXT,
      requirements TEXT,
      sales        TEXT,
      tags         TEXT,
      notes        TEXT,
      created_by   TEXT NOT NULL REFERENCES users(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      action      TEXT NOT NULL,
      payload     TEXT,
      performed_by TEXT NOT NULL REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      id           TEXT PRIMARY KEY,
      question     TEXT NOT NULL,
      answer       TEXT NOT NULL,
      tags         TEXT,
      related_users TEXT,
      created_by   TEXT NOT NULL REFERENCES users(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skills (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      prompt     TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL,
      description   TEXT,
      system_prompt TEXT,
      model         TEXT,
      provider      TEXT,
      tools_mode    TEXT NOT NULL DEFAULT 'all'
                    CHECK(tools_mode IN ('all', 'allowlist', 'blocklist')),
      tools_list    TEXT,
      max_history   INTEGER DEFAULT 80,
      created_by    TEXT NOT NULL REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_assignments (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      channel    TEXT NOT NULL,
      target_id  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(channel, target_id)
    );

    CREATE TABLE IF NOT EXISTS memory (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT,
      scope      TEXT NOT NULL DEFAULT 'global'
                 CHECK(scope IN ('global', 'agent')),
      content    TEXT NOT NULL,
      category   TEXT,
      source     TEXT NOT NULL DEFAULT 'manual'
                 CHECK(source IN ('manual', 'auto')),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
  `);

  // Migration: Add related_users and updated_at columns to knowledge table if they don't exist
  try {
    db.exec("ALTER TABLE knowledge ADD COLUMN related_users TEXT");
  } catch (e) {
    // Column may already exist, ignore
  }
  try {
    db.exec("ALTER TABLE knowledge ADD COLUMN updated_at TEXT");
  } catch (e) {
    // Column may already exist, ignore
  }
  // Update existing rows to set updated_at = created_at if null
  db.prepare("UPDATE knowledge SET updated_at = created_at WHERE updated_at IS NULL").run();

  // Migration: Add agent_id column to skills table
  try {
    db.exec("ALTER TABLE skills ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL");
  } catch (e) {
    // Column may already exist, ignore
  }

  // Migration: Add unique index on knowledge.question
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_question ON knowledge(question)");
  } catch (e) {
    // Index may already exist, ignore
  }

  // Seed default users if empty
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
  if (count.c === 0) {
    const insert = db.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)');
    insert.run('admin-001', 'admin', 'admin');
    insert.run('user-001', 'user', 'user');
  }

  // Seed default agents if empty
  const agentCount = db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
  if (agentCount.c === 0) {
    const ins = db.prepare(
      'INSERT INTO agents (id, name, display_name, description, tools_mode, tools_list, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const commonTools = JSON.stringify([
      'search_knowledge', 'list_skills', 'get_skill', 'save_skill', 'delete_skill',
      'get_status_summary', 'list_agents', 'get_agent', 'save_agent', 'delete_agent', 'switch_agent',
      'save_memory', 'search_memory', 'delete_memory',
      'read_file', 'write_file', 'reload_app',
    ]);
    ins.run('agent-otcclaw', 'otcclaw', '衍语助手', 'OTC 业务专家，客户管理、交易查询、展业支持', 'all', null, 'admin-001');
    ins.run('agent-doctor', 'doctor', '家庭医生', '健康咨询、症状分析、用药建议', 'allowlist', commonTools, 'admin-001');
    ins.run('agent-tutor', 'tutor', '教育辅导', '孩子学习辅导、作业答疑、学习规划', 'allowlist', commonTools, 'admin-001');
    ins.run('agent-alter-ego', 'alter-ego', '个人分身', '代表用户风格回答、日常助手', 'allowlist', commonTools, 'admin-001');
  }
}
