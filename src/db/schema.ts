import { getDb } from './connection.js';
import { v4 as uuid } from 'uuid';
import { TOOL_PRESETS, COMMON_SET } from '../llm/agents/config.js';

export function initSchema(): void {
  const db = getDb();

  /** Client + Trade + Health block list for admin + alter-ego (`tools_mode=all`); keep in sync with ensure-admin-block-tools-v3 / ensure-alter-ego-all-block-v1. */
  const ADMIN_AGENT_BLOCK_TOOLS: string[] = [
    'query_clients',
    'view_client',
    'get_client_history',
    'add_client',
    'update_client',
    'advance_client',
    'rollback_client',
    'delete_client',
    'query_trades',
    'trade_summary',
    'plot_trades',
    'list_customers',
    'add_health_record',
    'query_health_records',
    'health_summary',
    'archive_health_file',
    'list_health_files',
    'view_health_file',
    'log_sleep',
    'log_meal',
    'log_symptom',
    'set_medication_reminder',
  ];

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
      name       TEXT NOT NULL,
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
      tools_mode    TEXT NOT NULL DEFAULT 'standard'
                    CHECK(tools_mode IN ('all', 'standard', 'allowlist', 'blocklist')),
      tools_list    TEXT,
      block_tools   TEXT,
      preset        TEXT,
      user_tools_mode TEXT NOT NULL DEFAULT 'inherit'
                    CHECK(user_tools_mode IN ('inherit', 'all', 'allowlist', 'blocklist')),
      user_tools_list TEXT,
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

    CREATE TABLE IF NOT EXISTS bot_apps (
      id             TEXT PRIMARY KEY,
      channel        TEXT NOT NULL,
      name           TEXT NOT NULL,
      secret         TEXT NOT NULL,
      config         TEXT NOT NULL DEFAULT '{}',
      show_thinking  INTEGER NOT NULL DEFAULT 1,
      auto_start     INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Each migration runs exactly once, tracked by ID in the migrations table.
  const runOnce = (id: string, fn: () => void) => {
    if (db.prepare('SELECT 1 FROM migrations WHERE id = ?').get(id)) return;
    try {
      fn();
      db.prepare('INSERT INTO migrations (id) VALUES (?)').run(id);
    } catch (e) {
      // migration failure should not block startup
    }
  };

  runOnce('add-knowledge-columns', () => {
    try { db.exec("ALTER TABLE knowledge ADD COLUMN related_users TEXT"); } catch (e) {}
    try { db.exec("ALTER TABLE knowledge ADD COLUMN updated_at TEXT"); } catch (e) {}
    db.prepare("UPDATE knowledge SET updated_at = created_at WHERE updated_at IS NULL").run();
  });

  runOnce('add-skills-agent-id', () => {
    try {
      db.exec("ALTER TABLE skills ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL");
    } catch (e) {} // column may already exist
  });

  runOnce('add-skills-description', () => {
    try {
      db.exec("ALTER TABLE skills ADD COLUMN description TEXT");
    } catch (e) {}
  });

  runOnce('fix-skills-unique-constraint', () => {
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS skills_name_agent_unique ON skills(name, COALESCE(agent_id, ''))");
    } catch (e) {}
  });

  runOnce('rebuild-skills-drop-name-unique', () => {
    const hasOldUnique = (db.prepare(
      "SELECT COUNT(*) as cnt FROM pragma_index_list('skills') WHERE origin = 'u' AND name LIKE 'sqlite_autoindex_skills%'"
    ).get() as { cnt: number }).cnt > 0;
    if (hasOldUnique) {
      db.exec(`
        CREATE TABLE skills_new (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          prompt      TEXT NOT NULL,
          description TEXT,
          agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
          created_by  TEXT NOT NULL REFERENCES users(id),
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO skills_new SELECT id, name, prompt, description, agent_id, created_by, created_at FROM skills;
        DROP TABLE skills;
        ALTER TABLE skills_new RENAME TO skills;
        CREATE UNIQUE INDEX IF NOT EXISTS skills_name_agent_unique ON skills(name, COALESCE(agent_id, ''));
      `);
    }
  });

  runOnce('add-run-skill-to-agents', () => {
    const agents = db.prepare("SELECT id, tools_list FROM agents WHERE tools_list IS NOT NULL").all() as { id: string; tools_list: string }[];
    for (const agent of agents) {
      try {
        const tools: string[] = JSON.parse(agent.tools_list);
        if (!tools.includes('run_skill')) {
          tools.push('run_skill');
          db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE id=?")
            .run(JSON.stringify(tools), agent.id);
        }
      } catch (e) {}
    }
  });

  runOnce('add-knowledge-unique-index', () => {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_question ON knowledge(question)");
  });

  runOnce('add-todos-tags', () => {
    const todoCols = db.pragma('table_info(todos)') as Array<{ name: string }>;
    if (!todoCols.find(c => c.name === 'tags')) {
      db.exec("ALTER TABLE todos ADD COLUMN tags TEXT");
    }
  });

  runOnce('seed-default-users', () => {
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
    if (count.c === 0) {
      const insert = db.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)');
      insert.run('admin-001', 'admin', 'admin');
      insert.run('user-001', 'user', 'user');
    }
  });

  runOnce('seed-default-agents', () => {
    const agentCount = db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
    if (agentCount.c === 0) {
      const ins = db.prepare(
        'INSERT INTO agents (id, name, display_name, description, tools_mode, tools_list, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      const commonTools = JSON.stringify([
        'search_knowledge', 'list_skills', 'get_skill', 'save_skill', 'delete_skill', 'run_skill',
        'get_status_summary', 'list_agents', 'get_agent', 'save_agent', 'delete_agent', 'switch_agent',
        'save_memory', 'search_memory', 'delete_memory',
        'read_file', 'write_file', 'write_artifact', 'send_file', 'send_image', 'reload_app', 'exec_cmd',
      ]);
      const alterEgoTools = JSON.stringify([
        'search_knowledge', 'update_knowledge', 'extract_wework_qa', 'wework_monitor',
        'list_skills', 'get_skill', 'save_skill', 'delete_skill', 'run_skill',
        'get_status_summary', 'list_agents', 'get_agent', 'save_agent', 'delete_agent', 'switch_agent',
        'save_memory', 'search_memory', 'delete_memory',
        'read_file', 'write_file', 'write_artifact', 'send_file', 'send_image', 'reload_app', 'exec_cmd',
        'markdown_to_image',
      ]);
      ins.run('agent-otcclaw', 'otcclaw', '衍语助手', 'OTC 业务专家，客户管理、交易查询、展业支持', 'all', null, 'admin-001');
      ins.run('agent-doctor', 'doctor', '家庭医生', '健康咨询、症状分析、用药建议', 'allowlist', commonTools, 'admin-001');
      ins.run('agent-tutor', 'tutor', '教育辅导', '孩子学习辅导、作业答疑、学习规划', 'allowlist', commonTools, 'admin-001');
      ins.run('agent-alter-ego', 'alter-ego', '个人分身', '代表用户风格回答、日常助手', 'allowlist', alterEgoTools, 'admin-001');
    }
  });

  runOnce('seed-default-agent-members', () => {
    const agentMembersCount = db.prepare('SELECT COUNT(*) as c FROM agent_members').get() as { c: number };
    if (agentMembersCount.c === 0) {
      const agents = db.prepare('SELECT id, created_by FROM agents').all() as { id: string, created_by: string }[];
      const insMember = db.prepare('INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)');
      for (const agent of agents) {
        insMember.run(uuid(), agent.id, agent.created_by, 'admin');
      }
    }
  });

  runOnce('seed-default-feishu-apps', () => {
    const feishuAppsCount = db.prepare('SELECT COUNT(*) as c FROM feishu_apps').get() as { c: number };
    if (feishuAppsCount.c === 0) {
      const insApp = db.prepare(
        'INSERT OR IGNORE INTO feishu_apps (app_id, app_name, app_secret, verification_token, encrypt_key, show_thinking) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insApp.run('cli_a93212c0b7b9dcc5', 'otcclaw-bot', 'Ngdd5bLmxpgawK9ol3qRsbT4Navnq4Xa', '', '', 1);
      insApp.run('cli_a9329f3af5b8dcc9', 'tutor-bot', 'l69uf6jF04uEY6Urcn8Tjff0ytTxVSgy', '', '', 1);
    }
  });

  runOnce('populate-knowledge-agents', () => {
    const kaCount = db.prepare('SELECT COUNT(*) as c FROM knowledge_agents').get() as { c: number };
    if (kaCount.c === 0) {
      const allKnowledge = db.prepare('SELECT id FROM knowledge').all() as { id: string }[];
      const insKA = db.prepare('INSERT OR IGNORE INTO knowledge_agents (id, knowledge_id, agent_id) VALUES (?, ?, ?)');
      for (const k of allKnowledge) {
        insKA.run(uuid(), k.id, 'agent-otcclaw');
      }
    }
  });

  runOnce('alter-ego-add-qa-tools', () => {
    const aeRow = db.prepare("SELECT tools_list FROM agents WHERE name = 'alter-ego'").get() as { tools_list: string | null } | undefined;
    if (aeRow) {
      const current: string[] = aeRow.tools_list ? JSON.parse(aeRow.tools_list) : [];
      if (!current.includes('extract_wework_qa')) {
        const updated = [...new Set([...current, 'update_knowledge', 'extract_wework_qa'])];
        db.prepare("UPDATE agents SET tools_list = ? WHERE name = 'alter-ego'").run(JSON.stringify(updated));
      }
    }
  });

  runOnce('agent-assignments-add-app-id', () => {
    const cols = db.pragma('table_info(agent_assignments)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'app_id')) {
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
  });

  runOnce('alter-ego-add-wework-monitor', () => {
    const row = db.prepare("SELECT tools_list FROM agents WHERE name='alter-ego'").get() as { tools_list: string | null } | undefined;
    if (row) {
      const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
      if (!current.includes('wework_monitor')) {
        current.push('wework_monitor');
        db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE name='alter-ego'")
          .run(JSON.stringify(current));
      }
    }
  });

  runOnce('feishu-apps-add-auto-start', () => {
    const cols = db.pragma('table_info(feishu_apps)') as Array<{ name: string }>;
    if (!cols.find(c => c.name === 'auto_start')) {
      db.exec("ALTER TABLE feishu_apps ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 1");
    }
  });

  runOnce('migrate-feishu-apps-to-bot-apps', () => {
    const count = db.prepare('SELECT COUNT(*) as c FROM bot_apps').get() as { c: number };
    if (count.c === 0) {
      const rows = db.prepare('SELECT * FROM feishu_apps').all() as Array<{
        app_id: string; app_name: string; app_secret: string;
        verification_token: string; encrypt_key: string;
        show_thinking: number; auto_start: number; created_at: string;
      }>;
      const ins = db.prepare(
        'INSERT OR IGNORE INTO bot_apps (id, channel, name, secret, config, show_thinking, auto_start, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const r of rows) {
        const config = JSON.stringify({
          verification_token: r.verification_token || '',
          encrypt_key: r.encrypt_key || '',
        });
        ins.run(r.app_id, 'feishu', r.app_name, r.app_secret, config, r.show_thinking, r.auto_start, r.created_at);
      }
    }

    // Seed wework bot from env if configured
    const botId = process.env.WEWORK_AIBOT_BOT_ID;
    const secret = process.env.WEWORK_AIBOT_SECRET;
    if (botId && secret) {
      const exists = db.prepare('SELECT 1 FROM bot_apps WHERE id = ?').get(botId);
      if (!exists) {
        db.prepare(
          'INSERT INTO bot_apps (id, channel, name, secret, config, show_thinking, auto_start) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(botId, 'wework', 'wework-bot', secret, '{}', 1, 1);
      }
    }
  });

  runOnce('agents-add-exec-cmd', () => {
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
  });

  runOnce('agents-add-reminder-tools', () => {
    const reminderTools = ['set_reminder', 'list_reminders', 'cancel_reminder'];
    for (const agentName of ['tutor', 'doctor', 'alter-ego']) {
      const row = db.prepare("SELECT tools_list FROM agents WHERE name=?").get(agentName) as { tools_list: string | null } | undefined;
      if (row) {
        const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
        let changed = false;
        for (const tool of reminderTools) {
          if (!current.includes(tool)) { current.push(tool); changed = true; }
        }
        if (changed) {
          db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE name=?")
            .run(JSON.stringify(current), agentName);
        }
      }
    }
  });

  runOnce('add-feishu-admin-users', () => {
    db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'user')")
      .run('feishu_ou_d0076758ea8560d436638a7c78a8d26f', 'feishu_d26f');
    db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'user')")
      .run('feishu_ou_3a73e2e1bb61a5da577ba79eec33b00a', 'feishu_b00a');
    db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, '8f72afd2-3e8a-435b-8595-3bdbc653cff9', 'feishu_ou_d0076758ea8560d436638a7c78a8d26f', 'admin')")
      .run(uuid());
    db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, '575518a8-1f3d-4754-8815-243ef2ff3ea9', 'feishu_ou_3a73e2e1bb61a5da577ba79eec33b00a', 'admin')")
      .run(uuid());
  });

  runOnce('create-health-tables', () => {
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
  });

  runOnce('doctor-add-health-tools', () => {
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
4. **注意���项**：需要警惕的预警信号

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
  });

  runOnce('seed-browser-agent', () => {
    const browserAgent = db.prepare("SELECT id FROM agents WHERE name='browser'").get();
    if (!browserAgent) {
      const browserTools = JSON.stringify(TOOL_PRESETS.browser.tools);
      db.prepare(
        "INSERT INTO agents (id, name, display_name, description, tools_mode, tools_list, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run('agent-browser', 'browser', '浏览器助手', '网页浏览、截图、内容提取', 'allowlist', browserTools, 'admin-001');
      db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)")
        .run(uuid(), 'agent-browser', 'admin-001', 'admin');
    }
  });

  runOnce('agents-add-todo-tools', () => {
    const todoTools = ['create_todo', 'list_todos', 'update_todo', 'delete_todo'];
    for (const agentName of ['tutor', 'doctor', 'alter-ego']) {
      const row = db.prepare("SELECT tools_list FROM agents WHERE name=?").get(agentName) as { tools_list: string | null } | undefined;
      if (row) {
        const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
        let changed = false;
        for (const tool of todoTools) {
          if (!current.includes(tool)) { current.push(tool); changed = true; }
        }
        if (changed) {
          db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE name=?")
            .run(JSON.stringify(current), agentName);
        }
      }
    }
  });

  runOnce('doctor-add-lifestyle-tools', () => {
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
  });

  runOnce('agents-add-preset-column', () => {
    const agentCols = db.pragma('table_info(agents)') as Array<{ name: string }>;
    if (!agentCols.find(c => c.name === 'preset')) {
      db.exec("ALTER TABLE agents ADD COLUMN preset TEXT");
    }
  });

  runOnce('agents-backfill-preset', () => {
    db.prepare("UPDATE agents SET preset='common'    WHERE name IN ('doctor','tutor') AND preset IS NULL").run();
    db.prepare("UPDATE agents SET preset='alter_ego' WHERE name='alter-ego'           AND preset IS NULL").run();
  });

  runOnce('add-doctor-admin-user', () => {
    const userId = 'feishu_ou_7e6c4bfcb6a25a9909bd2fe4e7ad3230';
    db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'user')")
      .run(userId, 'feishu_3230');
    const doctorAgent = db.prepare("SELECT id FROM agents WHERE name='doctor'").get() as { id: string } | undefined;
    if (doctorAgent) {
      const exists = db.prepare("SELECT 1 FROM agent_members WHERE agent_id=? AND user_id=?").get(doctorAgent.id, userId);
      if (!exists) {
        db.prepare("INSERT INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, 'admin')")
          .run(uuid(), doctorAgent.id, userId);
      }
    }
  });

  runOnce('agents-add-user-tools-columns', () => {
    try { db.exec("ALTER TABLE agents ADD COLUMN user_tools_mode TEXT NOT NULL DEFAULT 'inherit'"); } catch (e) {}
    try { db.exec("ALTER TABLE agents ADD COLUMN user_tools_list TEXT"); } catch (e) {}
  });

  runOnce('alter-ego-add-markdown-to-image', () => {
    const row = db.prepare("SELECT tools_list FROM agents WHERE name='alter-ego'").get() as { tools_list: string | null } | undefined;
    if (row) {
      const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
      if (!current.includes('markdown_to_image')) {
        current.push('markdown_to_image');
        db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE name='alter-ego'")
          .run(JSON.stringify(current));
      }
    }
  });

  runOnce('agents-add-delivery-tools', () => {
    const deliveryTools = ['write_artifact', 'send_file', 'send_image'];
    for (const agentName of ['tutor', 'doctor', 'alter-ego']) {
      const row = db.prepare("SELECT tools_list FROM agents WHERE name=?").get(agentName) as { tools_list: string | null } | undefined;
      if (!row) continue;
      const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
      let changed = false;
      for (const tool of deliveryTools) {
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
  });

  runOnce('agents-add-media-gen-tools', () => {
    const mediaTools = ['generate_image', 'generate_video'];
    const agents = db.prepare("SELECT id, name, tools_list FROM agents WHERE tools_list IS NOT NULL").all() as { id: string; name: string; tools_list: string }[];
    for (const agent of agents) {
      const current: string[] = JSON.parse(agent.tools_list);
      let changed = false;
      for (const tool of mediaTools) {
        if (!current.includes(tool)) {
          current.push(tool);
          changed = true;
        }
      }
      if (changed) {
        db.prepare("UPDATE agents SET tools_list=?, updated_at=datetime('now') WHERE id=?")
          .run(JSON.stringify(current), agent.id);
      }
    }
  });

  runOnce('add-alter-ego-admin-36f292', () => {
    const userId = 'feishu_ou_0e6cf7a054dc5629fa4bb4209236f292';
    db.prepare("INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'user')")
      .run(userId, 'feishu_36f292');
    const agent = db.prepare("SELECT id FROM agents WHERE name='alter-ego'").get() as { id: string } | undefined;
    if (agent) {
      const exists = db.prepare("SELECT 1 FROM agent_members WHERE agent_id=? AND user_id=?").get(agent.id, userId);
      if (!exists) {
        db.prepare("INSERT INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, 'admin')")
          .run(uuid(), agent.id, userId);
      }
    }
  });

  runOnce('fix-feishu-hardcoded-usernames', () => {
    const renames: [string, string][] = [
      ['feishu_ou_d0076758ea8560d436638a7c78a8d26f', 'feishu_d26f'],
      ['feishu_ou_3a73e2e1bb61a5da577ba79eec33b00a', 'feishu_b00a'],
      ['feishu_ou_7e6c4bfcb6a25a9909bd2fe4e7ad3230', 'feishu_3230'],
    ];
    const update = db.prepare("UPDATE users SET username = ? WHERE id = ? AND username NOT LIKE 'feishu_%'");
    for (const [id, tempName] of renames) {
      update.run(tempName, id);
    }
  });

  // --- Agent Tools Matrix Refactor ---

  runOnce('agents-add-block-tools-column', () => {
    try { db.exec("ALTER TABLE agents ADD COLUMN block_tools TEXT"); } catch (e) {}
  });

  runOnce('agents-allow-standard-tools-mode', () => {
    // Recreate agents table with updated CHECK constraint to allow 'standard'.
    // Temporarily disable FK to prevent CASCADE deleting agent_assignments/agent_members.
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agents_new (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL UNIQUE,
          display_name  TEXT NOT NULL,
          description   TEXT,
          system_prompt TEXT,
          model         TEXT,
          provider      TEXT,
          tools_mode    TEXT NOT NULL DEFAULT 'standard'
                        CHECK(tools_mode IN ('all', 'standard', 'allowlist', 'blocklist')),
          tools_list    TEXT,
          block_tools   TEXT,
          preset        TEXT,
          user_tools_mode TEXT NOT NULL DEFAULT 'inherit'
                        CHECK(user_tools_mode IN ('inherit', 'all', 'allowlist', 'blocklist')),
          user_tools_list TEXT,
          max_history   INTEGER DEFAULT 80,
          created_by    TEXT NOT NULL,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const cols = db.pragma('table_info(agents)') as Array<{ name: string }>;
      const hasBlockTools = cols.some(c => c.name === 'block_tools');
      const hasPreset = cols.some(c => c.name === 'preset');
      const hasUserToolsMode = cols.some(c => c.name === 'user_tools_mode');
      const hasUserToolsList = cols.some(c => c.name === 'user_tools_list');

      db.exec(`
        INSERT INTO agents_new (id, name, display_name, description, system_prompt, model, provider,
          tools_mode, tools_list, block_tools, preset, user_tools_mode, user_tools_list, max_history, created_by, created_at, updated_at)
        SELECT id, name, display_name, description, system_prompt, model, provider,
          tools_mode, tools_list,
          ${hasBlockTools ? 'block_tools' : 'NULL'},
          ${hasPreset ? 'preset' : 'NULL'},
          ${hasUserToolsMode ? 'user_tools_mode' : "'inherit'"},
          ${hasUserToolsList ? 'user_tools_list' : 'NULL'},
          max_history, created_by, created_at, updated_at
        FROM agents;
      `);
      db.exec('DROP TABLE agents;');
      db.exec('ALTER TABLE agents_new RENAME TO agents;');
    } finally {
      db.pragma('foreign_keys = ON');
    }
  });

  runOnce('migrate-agents-to-standard-mode', () => {
    // Migrate all agents from legacy allowlist/blocklist/all to the new standard model.
    // tools_list is cleaned to only contain tools NOT in COMMON_SET.
    const commonArr = [...COMMON_SET];

    const agents = db.prepare("SELECT id, name, tools_mode, tools_list, preset FROM agents").all() as
      { id: string; name: string; tools_mode: string; tools_list: string | null; preset: string | null }[];

    for (const agent of agents) {
      // System admin agent stays tools_mode=all + block_tools (design matrix); do not flatten to standard.
      if (agent.name === 'admin') continue;
      // alter-ego may need upgrade from standard → all (aligned with admin); do not skip when standard.
      if (agent.tools_mode === 'standard' && agent.name !== 'alter-ego') continue;

      let allowTools: string[] = [];
      let blockTools: string[] = [];

      if (agent.name === 'otcclaw') {
        // otcclaw: standard mode, allow = Client + Trade + knowledge agent mgmt + markdown + update_memory; block generate_video (from COMMON_SET)
        allowTools = [
          'query_clients', 'view_client', 'get_client_history', 'add_client', 'update_client',
          'advance_client', 'rollback_client', 'delete_client',
          'query_trades', 'trade_summary', 'plot_trades', 'list_customers',
          'assign_knowledge_agent', 'unassign_knowledge_agent', 'get_knowledge_agents',
          'markdown_to_image', 'update_memory',
        ];
        blockTools = ['generate_video'];
      } else if (agent.name === 'alter-ego') {
        // alter-ego: same effective tools as admin — all \ (Client + Trade + Health)
        db.prepare(
          `UPDATE agents SET tools_mode='all', tools_list=NULL, block_tools=?, updated_at=datetime('now') WHERE id=?`,
        ).run(JSON.stringify(ADMIN_AGENT_BLOCK_TOOLS), agent.id);
        continue;
      } else if (agent.name === 'doctor') {
        // doctor: standard mode, allow = Health + update_memory
        allowTools = [
          'add_health_record', 'query_health_records', 'health_summary',
          'archive_health_file', 'list_health_files', 'view_health_file',
          'log_sleep', 'log_meal', 'log_symptom', 'set_medication_reminder',
          'update_memory',
        ];
      } else if (agent.name === 'tutor') {
        // tutor: pure COMMON_SET, no extra allow/block
        allowTools = [];
      } else if (agent.name === 'browser') {
        // browser: keep its special MCP tools as allow, no COMMON_SET overlap
        const current: string[] = agent.tools_list ? JSON.parse(agent.tools_list) : [];
        allowTools = current.filter(t => !COMMON_SET.has(t));
      } else {
        // Other agents: keep their tools_list minus COMMON_SET as allow
        const current: string[] = agent.tools_list ? JSON.parse(agent.tools_list) : [];
        allowTools = current.filter(t => !COMMON_SET.has(t));
      }

      db.prepare(`UPDATE agents SET tools_mode='standard', tools_list=?, block_tools=?, updated_at=datetime('now') WHERE id=?`)
        .run(
          allowTools.length > 0 ? JSON.stringify(allowTools) : null,
          blockTools.length > 0 ? JSON.stringify(blockTools) : null,
          agent.id,
        );
    }
  });

  runOnce('seed-falcon-potato-man-agents', () => {
    const ins = db.prepare(
      'INSERT OR IGNORE INTO agents (id, name, display_name, description, tools_mode, tools_list, block_tools, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insMember = db.prepare('INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)');

    // falcon: monitoring agent, block heavy tools from COMMON_SET
    const falconBlock = JSON.stringify(['generate_image', 'generate_video', 'save_skill']);
    ins.run('agent-falcon', 'falcon', '消息监控', '监控推送、消息提醒', 'standard', null, falconBlock, 'admin-001');
    insMember.run(uuid(), 'agent-falcon', 'admin-001', 'admin');

    // potato: common assistant for 丁丁
    ins.run('agent-potato', 'potato', '丁丁助理', '丁丁的个人助理', 'standard', null, null, 'admin-001');
    insMember.run(uuid(), 'agent-potato', 'admin-001', 'admin');

    // man: common assistant for 黄老师
    ins.run('agent-man', 'man', '黄老师助理', '黄老师的个人助理', 'standard', null, null, 'admin-001');
    insMember.run(uuid(), 'agent-man', 'admin-001', 'admin');
  });

  /** Design: falcon block_tools = generate_image, generate_video, save_skill. INSERT OR IGNORE does not repair existing rows. */
  runOnce('ensure-falcon-block-tools-v2', () => {
    const falconBlock = JSON.stringify(['generate_image', 'generate_video', 'save_skill']);
    db.prepare(`UPDATE agents SET block_tools = ?, updated_at = datetime('now') WHERE name = 'falcon'`).run(falconBlock);
  });

  runOnce('seed-system-admin-agent', () => {
    const adminBlock = JSON.stringify(ADMIN_AGENT_BLOCK_TOOLS);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, display_name, description, tools_mode, tools_list, block_tools, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run(
      'agent-admin',
      'admin',
      '系统管理员',
      'CLI 系统管理、全量工具减 Client/Trade/Health',
      'all',
      null,
      adminBlock,
      'admin-001',
    );
    db.prepare(
      `UPDATE agents SET tools_mode = 'all', tools_list = NULL, block_tools = ?, updated_at = datetime('now') WHERE name = 'admin'`,
    ).run(adminBlock);
    const insMember = db.prepare(
      `INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)`,
    );
    const row = db.prepare(`SELECT id FROM agents WHERE name = 'admin'`).get() as { id: string } | undefined;
    if (row) insMember.run(uuid(), row.id, 'admin-001', 'admin');
  });

  runOnce('ensure-admin-block-tools-v3', () => {
    db.prepare(`UPDATE agents SET block_tools = ?, updated_at = datetime('now') WHERE name = 'admin'`).run(
      JSON.stringify(ADMIN_AGENT_BLOCK_TOOLS),
    );
  });

  /** Same effective set as admin: all minus Client, Trade, Health. Keeps DB aligned if rows drift. */
  runOnce('ensure-alter-ego-all-block-v1', () => {
    const blockJson = JSON.stringify(ADMIN_AGENT_BLOCK_TOOLS);
    db.prepare(
      `UPDATE agents SET tools_mode = 'all', tools_list = NULL, block_tools = ?, updated_at = datetime('now') WHERE name = 'alter-ego'`,
    ).run(blockJson);
  });

  runOnce('seed-member-default-blocklist', () => {
    /** Align docs/plan [^member-mutation-block]; doctor gets same row — adjust via save_agent after per-tool review. */
    const MEMBER_MUTATION_BLOCK = [
      'exec_cmd',
      'reload_app',
      'read_file',
      'list_directory',
      'write_file',
      'edit_file',
      'add_knowledge',
      'update_knowledge',
      'delete_knowledge',
      'assign_knowledge_agent',
      'unassign_knowledge_agent',
      'save_skill',
      'delete_skill',
      'save_memory',
      'update_memory',
      'delete_memory',
      'create_todo',
      'update_todo',
      'delete_todo',
      'set_reminder',
      'cancel_reminder',
    ];
    const json = JSON.stringify(MEMBER_MUTATION_BLOCK);
    db.prepare(
      `UPDATE agents SET user_tools_mode = 'blocklist', user_tools_list = ?, updated_at = datetime('now')`
    ).run(json);
  });

  // Recovery: the 'agents-allow-standard-tools-mode' migration had foreign_keys ON
  // when it DROP'd agents table, causing CASCADE deletion of agent_members,
  // agent_assignments, knowledge_agents, and memory rows.
  runOnce('recover-cascade-deleted-data', () => {
    // 1. Re-seed agent_members (creator = admin for each agent)
    const agents = db.prepare('SELECT id, created_by FROM agents').all() as { id: string; created_by: string }[];
    const insMember = db.prepare('INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)');
    for (const agent of agents) {
      const exists = db.prepare('SELECT 1 FROM agent_members WHERE agent_id=? AND user_id=?').get(agent.id, agent.created_by);
      if (!exists) {
        insMember.run(uuid(), agent.id, agent.created_by, 'admin');
      }
    }

    // Re-add known feishu user → agent memberships (from prior runOnce seeds)
    const knownMemberships: Array<{ userId: string; agentNames: string[] }> = [
      { userId: 'feishu_ou_d0076758ea8560d436638a7c78a8d26f', agentNames: ['tutor', 'otcclaw'] },
      { userId: 'feishu_ou_3a73e2e1bb61a5da577ba79eec33b00a', agentNames: ['otcclaw'] },
      { userId: 'feishu_ou_7e6c4bfcb6a25a9909bd2fe4e7ad3230', agentNames: ['doctor'] },
      { userId: 'feishu_ou_0e6cf7a054dc5629fa4bb4209236f292', agentNames: ['alter-ego'] },
    ];
    for (const m of knownMemberships) {
      for (const agentName of m.agentNames) {
        const agent = db.prepare('SELECT id FROM agents WHERE name=?').get(agentName) as { id: string } | undefined;
        if (agent) {
          const exists = db.prepare('SELECT 1 FROM agent_members WHERE agent_id=? AND user_id=?').get(agent.id, m.userId);
          if (!exists) {
            insMember.run(uuid(), agent.id, m.userId, 'admin');
          }
        }
      }
    }

    // 2. Re-seed agent_assignments from bot_apps by name convention
    const apps = db.prepare('SELECT id, channel, name FROM bot_apps').all() as { id: string; channel: string; name: string }[];
    const insAssign = db.prepare(
      'INSERT OR IGNORE INTO agent_assignments (id, agent_id, channel, app_id) VALUES (?, ?, ?, ?)'
    );
    function inferAgentName(appName: string): string | null {
      if (appName.endsWith('-bot')) return appName.slice(0, -4);
      return null;
    }
    for (const app of apps) {
      const agentName = inferAgentName(app.name);
      if (!agentName) {
        console.warn(`[recover] Cannot infer agent for ${app.channel} app "${app.name}" (${app.id}), run /agent assign manually`);
        continue;
      }
      const agent = db.prepare('SELECT id FROM agents WHERE name=?').get(agentName) as { id: string } | undefined;
      if (!agent) continue;
      const exists = db.prepare('SELECT 1 FROM agent_assignments WHERE channel=? AND app_id=?').get(app.channel, app.id);
      if (!exists) {
        insAssign.run(uuid(), agent.id, app.channel, app.id);
      }
    }

    // 3. Re-link knowledge → otcclaw agent (original seed linked all knowledge to otcclaw)
    const otcclaw = db.prepare("SELECT id FROM agents WHERE name='otcclaw'").get() as { id: string } | undefined;
    if (otcclaw) {
      const allKnowledge = db.prepare('SELECT id FROM knowledge').all() as { id: string }[];
      const insKA = db.prepare('INSERT OR IGNORE INTO knowledge_agents (id, knowledge_id, agent_id) VALUES (?, ?, ?)');
      for (const k of allKnowledge) {
        const exists = db.prepare('SELECT 1 FROM knowledge_agents WHERE knowledge_id=? AND agent_id=?').get(k.id, otcclaw.id);
        if (!exists) {
          insKA.run(uuid(), k.id, otcclaw.id);
        }
      }
    }
  });

  runOnce('user-blocklist-add-extract-wework-qa', () => {
    const rows = db.prepare("SELECT id, user_tools_list FROM agents WHERE user_tools_mode = 'blocklist' AND user_tools_list IS NOT NULL").all() as { id: string; user_tools_list: string }[];
    for (const row of rows) {
      const current: string[] = JSON.parse(row.user_tools_list);
      if (!current.includes('extract_wework_qa')) {
        current.push('extract_wework_qa');
        db.prepare("UPDATE agents SET user_tools_list = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(current), row.id);
      }
    }
  });

  runOnce('otcclaw-add-query-hedge-short', () => {
    const row = db.prepare("SELECT tools_list FROM agents WHERE name = 'otcclaw'").get() as { tools_list: string | null } | undefined;
    if (row) {
      const current: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
      if (!current.includes('query_hedge_short')) {
        current.push('query_hedge_short');
        db.prepare("UPDATE agents SET tools_list = ?, updated_at = datetime('now') WHERE name = 'otcclaw'")
          .run(JSON.stringify(current));
      }
    }
  });

  runOnce('user-blocklist-otcclaw-add-client-video', () => {
    const row = db.prepare("SELECT user_tools_list FROM agents WHERE name = 'otcclaw'").get() as { user_tools_list: string | null } | undefined;
    if (row) {
      const current: string[] = row.user_tools_list ? JSON.parse(row.user_tools_list) : [];
      const toAdd = ['add_client', 'update_client', 'advance_client', 'rollback_client'];
      let changed = false;
      for (const tool of toAdd) {
        if (!current.includes(tool)) { current.push(tool); changed = true; }
      }
      if (changed) {
        db.prepare("UPDATE agents SET user_tools_list = ?, updated_at = datetime('now') WHERE name = 'otcclaw'")
          .run(JSON.stringify(current));
      }
    }
  });

  runOnce('otcclaw-remove-generate-video-extract-wework-qa', () => {
    const row = db.prepare(
      "SELECT tools_list, block_tools, user_tools_list FROM agents WHERE name = 'otcclaw'",
    ).get() as { tools_list: string | null; block_tools: string | null; user_tools_list: string | null } | undefined;
    if (!row) return;

    let toolsList: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    toolsList = toolsList.filter((t) => t !== 'extract_wework_qa');
    const toolsListJson = toolsList.length > 0 ? JSON.stringify(toolsList) : null;

    const blockTools: string[] = row.block_tools ? JSON.parse(row.block_tools) : [];
    if (!blockTools.includes('generate_video')) blockTools.push('generate_video');
    const blockToolsJson = blockTools.length > 0 ? JSON.stringify(blockTools) : null;

    let newUserToolsList: string | null = row.user_tools_list;
    if (row.user_tools_list) {
      const u: string[] = JSON.parse(row.user_tools_list).filter((t: string) => t !== 'generate_video');
      newUserToolsList = JSON.stringify(u);
    }

    db.prepare(
      "UPDATE agents SET tools_list = ?, block_tools = ?, user_tools_list = ?, updated_at = datetime('now') WHERE name = 'otcclaw'",
    ).run(toolsListJson, blockToolsJson, newUserToolsList);
  });
}
