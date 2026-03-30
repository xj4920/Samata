import { getDb } from './connection.js';
import { v4 as uuid } from 'uuid';
import { TOOL_PRESETS } from '../llm/agents/config.js';

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

    CREATE TABLE IF NOT EXISTS agent_members (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, user_id)
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

    CREATE TABLE IF NOT EXISTS knowledge_agents (
      id           TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(knowledge_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS feishu_apps (
      app_id             TEXT PRIMARY KEY,
      app_name           TEXT NOT NULL,
      app_secret         TEXT NOT NULL,
      verification_token TEXT NOT NULL DEFAULT '',
      encrypt_key        TEXT NOT NULL DEFAULT '',
      show_thinking      INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      message    TEXT NOT NULL,
      remind_at  INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending', 'delivered', 'cancelled')),
      channel    TEXT NOT NULL,
      target_id  TEXT NOT NULL,
      app_id     TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS todos (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT REFERENCES agents(id) ON DELETE CASCADE,
      user_id     TEXT REFERENCES users(id),
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending', 'in_progress', 'done')),
      priority    TEXT NOT NULL DEFAULT 'normal'
                  CHECK(priority IN ('low', 'normal', 'high')),
      due_date    TEXT,
      tags        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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

  // Migration: Add tags column to todos (for DBs created before tags was added to schema)
  try {
    const todoCols = db.pragma('table_info(todos)') as Array<{ name: string }>;
    if (!todoCols.find(c => c.name === 'tags')) {
      db.exec("ALTER TABLE todos ADD COLUMN tags TEXT");
    }
  } catch (e) {
    // Migration failure should not block startup
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
      'read_file', 'write_file', 'reload_app', 'exec_cmd',
    ]);
    const alterEgoTools = JSON.stringify([
      'search_knowledge', 'update_knowledge', 'extract_wework_qa', 'wework_monitor',
      'list_skills', 'get_skill', 'save_skill', 'delete_skill',
      'get_status_summary', 'list_agents', 'get_agent', 'save_agent', 'delete_agent', 'switch_agent',
      'save_memory', 'search_memory', 'delete_memory',
      'read_file', 'write_file', 'reload_app', 'exec_cmd',
      'markdown_to_image',
    ]);
    ins.run('agent-otcclaw', 'otcclaw', '衍语助手', 'OTC 业务专家，客户管理、交易查询、展业支持', 'all', null, 'admin-001');
    ins.run('agent-doctor', 'doctor', '家庭医生', '健康咨询、症状分析、用药建议', 'allowlist', commonTools, 'admin-001');
    ins.run('agent-tutor', 'tutor', '教育辅导', '孩子学习辅导、作业答疑、学习规划', 'allowlist', commonTools, 'admin-001');
    ins.run('agent-alter-ego', 'alter-ego', '个人分身', '代表用户风格回答、日常助手', 'allowlist', alterEgoTools, 'admin-001');
  }

  // Seed default agent_members (Migration)
  const agentMembersCount = db.prepare('SELECT COUNT(*) as c FROM agent_members').get() as { c: number };
  if (agentMembersCount.c === 0) {
    const agents = db.prepare('SELECT id, created_by FROM agents').all() as { id: string, created_by: string }[];
    const insMember = db.prepare('INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)');
    for (const agent of agents) {
        // give the creator 'admin' role in the agent
        const id = uuid();
        insMember.run(id, agent.id, agent.created_by, 'admin');
    }
  }

  // Seed default feishu_apps if empty
  const feishuAppsCount = db.prepare('SELECT COUNT(*) as c FROM feishu_apps').get() as { c: number };
  if (feishuAppsCount.c === 0) {
    const insApp = db.prepare(
      'INSERT OR IGNORE INTO feishu_apps (app_id, app_name, app_secret, verification_token, encrypt_key, show_thinking) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insApp.run('cli_a93212c0b7b9dcc5', 'otcclaw-bot', 'Ngdd5bLmxpgawK9ol3qRsbT4Navnq4Xa', '', '', 1);
    insApp.run('cli_a9329f3af5b8dcc9', 'tutor-bot', 'l69uf6jF04uEY6Urcn8Tjff0ytTxVSgy', '', '', 1);
  }

  // Migration: Populate knowledge_agents — associate all existing knowledge with otcclaw agent
  try {
    const kaCount = db.prepare('SELECT COUNT(*) as c FROM knowledge_agents').get() as { c: number };
    if (kaCount.c === 0) {
      const allKnowledge = db.prepare('SELECT id FROM knowledge').all() as { id: string }[];
      const insKA = db.prepare('INSERT OR IGNORE INTO knowledge_agents (id, knowledge_id, agent_id) VALUES (?, ?, ?)');
      for (const k of allKnowledge) {
        insKA.run(uuid(), k.id, 'agent-otcclaw');
      }
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Add QA tools to alter-ego
  const aeRow = db.prepare("SELECT tools_list FROM agents WHERE name = 'alter-ego'").get() as { tools_list: string | null } | undefined;
  if (aeRow) {
    const current: string[] = aeRow.tools_list ? JSON.parse(aeRow.tools_list) : [];
    if (!current.includes('extract_wework_qa')) {
      const updated = [...new Set([...current, 'update_knowledge', 'extract_wework_qa'])];
      db.prepare("UPDATE agents SET tools_list = ? WHERE name = 'alter-ego'").run(JSON.stringify(updated));
    }
  }

  // Migration: Add app_id column to agent_assignments
  try {
    const cols = db.pragma('table_info(agent_assignments)') as Array<{ name: string }>;
    const hasAppId = cols.some(c => c.name === 'app_id');

    if (!hasAppId) {
      db.exec(`
        CREATE TABLE agent_assignments_new (
          id         TEXT PRIMARY KEY,
          agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          channel    TEXT NOT NULL,
          app_id     TEXT,
          target_id  TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(channel, app_id, target_id)
        );
      `);

      db.exec(`
        INSERT INTO agent_assignments_new (id, agent_id, channel, app_id, target_id, created_at)
        SELECT id, agent_id, channel, NULL, target_id, created_at FROM agent_assignments;
      `);

      db.exec('DROP TABLE agent_assignments;');
      db.exec('ALTER TABLE agent_assignments_new RENAME TO agent_assignments;');
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Add wework_monitor to alter-ego tools_list
  try {
    const alterEgoRow = db.prepare("SELECT tools_list FROM agents WHERE name='alter-ego'").get() as { tools_list: string | null } | undefined;
    if (alterEgoRow) {
      const currentTools: string[] = alterEgoRow.tools_list ? JSON.parse(alterEgoRow.tools_list) : [];
      if (!currentTools.includes('wework_monitor')) {
        currentTools.push('wework_monitor');
        db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE name='alter-ego'")
          .run(JSON.stringify(currentTools));
      }
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Add auto_start column to feishu_apps
  try {
    const cols = db.pragma('table_info(feishu_apps)') as Array<{ name: string }>;
    if (!cols.find(c => c.name === 'auto_start')) {
      db.exec("ALTER TABLE feishu_apps ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 1");
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Add exec_cmd to tutor and alter-ego tools_list
  try {
    for (const agentName of ['tutor', 'alter-ego']) {
      const row = db.prepare("SELECT tools_list FROM agents WHERE name=?").get(agentName) as { tools_list: string | null } | undefined;
      if (row) {
        const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
        if (!current.includes('exec_cmd')) {
          current.push('exec_cmd');
          db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE name=?")
            .run(JSON.stringify(current), agentName);
        }
      }
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Add reminder tools to tutor, doctor, alter-ego tools_list
  try {
    const reminderTools = ['set_reminder', 'list_reminders', 'cancel_reminder'];
    for (const agentName of ['tutor', 'doctor', 'alter-ego']) {
      const row = db.prepare("SELECT tools_list FROM agents WHERE name=?").get(agentName) as { tools_list: string | null } | undefined;
      if (row) {
        const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
        let changed = false;
        for (const tool of reminderTools) {
          if (!current.includes(tool)) {
            current.push(tool);
            changed = true;
          }
        }
        if (changed) {
          db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE name=?")
            .run(JSON.stringify(current), agentName);
        }
      }
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: per-feishu-user records for Moss and Falcon + agent_members
  try {
    db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'user')")
      .run('feishu_ou_d0076758ea8560d436638a7c78a8d26f', 'tutor-admin');
    db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'user')")
      .run('feishu_ou_3a73e2e1bb61a5da577ba79eec33b00a', 'falcon-admin');
    db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, '8f72afd2-3e8a-435b-8595-3bdbc653cff9', 'feishu_ou_d0076758ea8560d436638a7c78a8d26f', 'admin')")
      .run(uuid());
    db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, '575518a8-1f3d-4754-8815-243ef2ff3ea9', 'feishu_ou_3a73e2e1bb61a5da577ba79eec33b00a', 'admin')")
      .run(uuid());
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Create health_records and health_files tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_records (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      record_type TEXT NOT NULL,
      value       TEXT NOT NULL,
      unit        TEXT,
      measured_at TEXT NOT NULL,
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS health_files (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      doc_type    TEXT NOT NULL,
      measured_at TEXT NOT NULL,
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: Add health tools and system_prompt to doctor agent
  try {
    const doctorRow = db.prepare("SELECT tools_list, system_prompt FROM agents WHERE name='doctor'").get() as { tools_list: string | null; system_prompt: string | null } | undefined;
    if (doctorRow) {
      const current: string[] = doctorRow.tools_list ? JSON.parse(doctorRow.tools_list) : [];
      const healthTools = ['add_health_record', 'query_health_records', 'health_summary',
        'archive_health_file', 'list_health_files', 'view_health_file', 'set_medication_reminder'];
      let changed = false;
      for (const tool of healthTools) {
        if (!current.includes(tool)) { current.push(tool); changed = true; }
      }
      const doctorPrompt = `你是家庭医生助手，具备基础医学知识，能够协助用户管理日常健康数据、解读检查报告、提供用药提醒和健康建议。

**服务范围**
- 健康数据记录与趋势分析（血压、血糖、体重等指标）
- 检查报告解读（血常规、生化、影像等）
- 用药提醒设置与管理
- 常见症状初步分析（仅供参考）
- 健康生活方式建议

**回答格式**
1. **情况评估**：简要描述当前情况
2. **可能原因**：列出 2-3 个最可能的原因
3. **建议措施**：具体可操作的建议（就医/用药/生活方式）
4. **注意事项**：需要警惕的预警信号

**免责声明**
本助手提供的信息仅供参考，不构成医疗诊断或处方建议。若出现严重或持续症状，请及时就医。用药请遵医嘱，不得自行调整处方药剂量。`;

      const updates: string[] = [];
      const params: any[] = [];
      if (changed) { updates.push('tools_list = ?'); params.push(JSON.stringify(current)); }
      if (!doctorRow.system_prompt) { updates.push('system_prompt = ?'); params.push(doctorPrompt); }
      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE name = 'doctor'`).run(...params);
      }
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Seed browser agent
  try {
    const browserAgent = db.prepare("SELECT id FROM agents WHERE name='browser'").get();
    if (!browserAgent) {
      const browserTools = JSON.stringify(TOOL_PRESETS.browser.tools);
      db.prepare(
        "INSERT INTO agents (id, name, display_name, description, tools_mode, tools_list, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run('agent-browser', 'browser', '浏览器助手', '网页浏览、截图、内容提取', 'allowlist', browserTools, 'admin-001');
      db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)")
        .run(uuid(), 'agent-browser', 'admin-001', 'admin');
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Add todo tools to tutor, doctor, alter-ego tools_list
  try {
    const todoTools = ['create_todo', 'list_todos', 'update_todo', 'delete_todo'];
    for (const agentName of ['tutor', 'doctor', 'alter-ego']) {
      const row = db.prepare("SELECT tools_list FROM agents WHERE name=?").get(agentName) as { tools_list: string | null } | undefined;
      if (row) {
        const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
        let changed = false;
        for (const tool of todoTools) {
          if (!current.includes(tool)) {
            current.push(tool);
            changed = true;
          }
        }
        if (changed) {
          db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE name=?")
            .run(JSON.stringify(current), agentName);
        }
      }
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Add sleep/meal/symptom logging tools to doctor tools_list
  try {
    const lifestyleTools = ['log_sleep', 'log_meal', 'log_symptom'];
    const row = db.prepare("SELECT tools_list FROM agents WHERE name='doctor'").get() as { tools_list: string | null } | undefined;
    if (row) {
      const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
      let changed = false;
      for (const tool of lifestyleTools) {
        if (!current.includes(tool)) { current.push(tool); changed = true; }
      }
      if (changed) {
        db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE name='doctor'")
          .run(JSON.stringify(current));
      }
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Add preset column to agents
  try {
    const agentCols = db.pragma('table_info(agents)') as Array<{ name: string }>;
    if (!agentCols.find(c => c.name === 'preset')) {
      db.exec("ALTER TABLE agents ADD COLUMN preset TEXT");
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Backfill preset for seeded agents
  try {
    db.prepare("UPDATE agents SET preset='common'    WHERE name IN ('doctor','tutor') AND preset IS NULL").run();
    db.prepare("UPDATE agents SET preset='alter_ego' WHERE name='alter-ego'           AND preset IS NULL").run();
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Add ou_7e6c4bfcb6a25a9909bd2fe4e7ad3230 as doctor agent admin
  try {
    const userId = 'feishu_ou_7e6c4bfcb6a25a9909bd2fe4e7ad3230';
    db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'user')")
      .run(userId, 'doctor-admin');
    const doctorAgent = db.prepare("SELECT id FROM agents WHERE name='doctor'").get() as { id: string } | undefined;
    if (doctorAgent) {
      const exists = db.prepare("SELECT 1 FROM agent_members WHERE agent_id=? AND user_id=?").get(doctorAgent.id, userId);
      if (!exists) {
        db.prepare("INSERT INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, 'admin')")
          .run(uuid(), doctorAgent.id, userId);
      }
    }
  } catch (e) {
    // Migration failure should not block startup
  }

  // Migration: Add markdown_to_image to alter-ego tools_list
  try {
    const row = db.prepare("SELECT tools_list FROM agents WHERE name='alter-ego'").get() as { tools_list: string | null } | undefined;
    if (row) {
      const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
      if (!current.includes('markdown_to_image')) {
        current.push('markdown_to_image');
        db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE name='alter-ego'")
          .run(JSON.stringify(current));
      }
    }
  } catch (e) {
    // Migration failure should not block startup
  }
}
