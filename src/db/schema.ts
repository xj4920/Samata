import fs from 'fs';
import { createHash } from 'node:crypto';
import { resolve, join, isAbsolute, relative, sep, extname } from 'path';
import { getDb } from './connection.js';
import { v4 as uuid } from 'uuid';
import { TOOL_PRESETS, COMMON_SET } from '../llm/agents/config.js';

/** System tools beyond COMMON_SET granted to TIClaw agent */
const TICLAW_EXTRA_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'list_directory',
  'exec_cmd', 'reload_app',
  'sandbox_exec', 'sandbox_list', 'sandbox_read_file', 'sandbox_write_file',
  'list_agents', 'get_agent', 'save_agent', 'delete_agent', 'switch_agent',
  'assign_agent', 'unassign_agent', 'list_agent_assignments',
  'list_agent_members', 'manage_agent_member',
  'assign_knowledge_agent', 'unassign_knowledge_agent', 'get_knowledge_agents',
  'update_memory', 'markdown_to_image', 'http_request', 'list_tool_presets',
];

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

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      name        TEXT NOT NULL,
      cron_expr   TEXT NOT NULL,
      task_type   TEXT NOT NULL CHECK(task_type IN ('remind', 'sandbox_exec')),
      payload     TEXT NOT NULL,
      channel     TEXT NOT NULL,
      target_id   TEXT,
      app_id      TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_result TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      created_by  TEXT
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

    CREATE TABLE IF NOT EXISTS wrong_questions (
      id                 TEXT PRIMARY KEY,
      agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject            TEXT NOT NULL CHECK(subject IN ('math', 'chinese', 'english', 'science')),
      question_summary   TEXT NOT NULL,
      wrong_answer       TEXT,
      expected_direction TEXT,
      error_type         TEXT NOT NULL DEFAULT 'knowledge' CHECK(error_type IN ('knowledge', 'logic')),
      error_subtype      TEXT,
      analysis           TEXT,
      status             TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'mastered')),
      mistake_count      INTEGER NOT NULL DEFAULT 1,
      source_type        TEXT NOT NULL DEFAULT 'text' CHECK(source_type IN ('text', 'image', 'document')),
      storage_dir        TEXT,
      created_by         TEXT NOT NULL REFERENCES users(id),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      last_wrong_at      TEXT NOT NULL DEFAULT (datetime('now')),
      mastered_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS wrong_question_assets (
      id                TEXT PRIMARY KEY,
      wrong_question_id TEXT NOT NULL REFERENCES wrong_questions(id) ON DELETE CASCADE,
      asset_role        TEXT NOT NULL DEFAULT 'original'
                          CHECK(asset_role IN ('original', 'annotated', 'cropped', 'ocr')),
      file_name         TEXT NOT NULL,
      file_ext          TEXT,
      mime_type         TEXT,
      size_bytes        INTEGER,
      stored_path       TEXT NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
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
      ins.run('agent-otcclaw', 'otcclaw', '衍语', 'OTC 业务专家，客户管理、交易查询、展业支持', 'all', null, 'admin-001');
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
    // system prompt 已迁移到 config/agents/doctor.md，这里只保留 tools_list 更新
    const doctorRow = db.prepare("SELECT tools_list FROM agents WHERE name='doctor'").get() as { tools_list: string | null } | undefined;
    if (doctorRow) {
      const current: string[] = doctorRow.tools_list ? JSON.parse(doctorRow.tools_list) : [];
      const healthTools = ['add_health_record', 'query_health_records', 'health_summary',
        'set_medication_reminder'];
      let changed = false;
      for (const tool of healthTools) {
        if (!current.includes(tool)) { current.push(tool); changed = true; }
      }
      if (changed) {
        db.prepare("UPDATE agents SET tools_list = ?, updated_at = datetime('now') WHERE name = 'doctor'")
          .run(JSON.stringify(current));
      }
    }
  });

  runOnce('doctor-remove-archive-health-file', () => {
    const doctorRow = db.prepare("SELECT tools_list FROM agents WHERE name='doctor'").get() as { tools_list: string | null } | undefined;
    if (doctorRow?.tools_list) {
      const current: string[] = JSON.parse(doctorRow.tools_list);
      const removed = ['archive_health_file', 'list_health_files', 'view_health_file'];
      const next = current.filter(t => !removed.includes(t));
      if (next.length !== current.length) {
        db.prepare("UPDATE agents SET tools_list = ?, updated_at = datetime('now') WHERE name = 'doctor'")
          .run(next.length > 0 ? JSON.stringify(next) : null);
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
      'import_document',
      'delete_document',
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

  runOnce('add-documents-table', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        source_path TEXT NOT NULL,
        file_type   TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        agent_id    TEXT REFERENCES agents(id),
        created_by  TEXT NOT NULL REFERENCES users(id),
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    try { db.exec("ALTER TABLE knowledge ADD COLUMN document_id TEXT REFERENCES documents(id) ON DELETE CASCADE"); } catch (e) {}
  });

  runOnce('user-blocklist-add-document-tools', () => {
    const rows = db.prepare("SELECT id, user_tools_list FROM agents WHERE user_tools_mode = 'blocklist' AND user_tools_list IS NOT NULL").all() as { id: string; user_tools_list: string }[];
    for (const row of rows) {
      const current: string[] = JSON.parse(row.user_tools_list);
      let changed = false;
      for (const tool of ['import_document', 'delete_document']) {
        if (!current.includes(tool)) { current.push(tool); changed = true; }
      }
      if (changed) {
        db.prepare("UPDATE agents SET user_tools_list = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(current), row.id);
      }
    }
  });

  /** Covers blocklist agents with NULL user_tools_list missed by user-blocklist-add-document-tools. */
  runOnce('user-blocklist-document-tools-nullsafe', () => {
    const rows = db.prepare("SELECT id, user_tools_list FROM agents WHERE user_tools_mode = 'blocklist'").all() as {
      id: string;
      user_tools_list: string | null;
    }[];
    for (const row of rows) {
      const current: string[] = row.user_tools_list ? JSON.parse(row.user_tools_list) : [];
      let changed = false;
      for (const tool of ['import_document', 'delete_document']) {
        if (!current.includes(tool)) {
          current.push(tool);
          changed = true;
        }
      }
      if (changed) {
        db.prepare("UPDATE agents SET user_tools_list = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(current), row.id);
      }
    }
  });

  runOnce('add-documents-stored-path', () => {
    try { db.exec("ALTER TABLE documents ADD COLUMN stored_path TEXT"); } catch (e) {}
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

  runOnce('add-pricing-schedule-columns', () => {
    const cols = db.pragma('table_info(clients)') as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has('long_financing_spread')) {
      db.exec('ALTER TABLE clients ADD COLUMN long_financing_spread REAL');
    }
    if (!colNames.has('short_financing')) {
      db.exec('ALTER TABLE clients ADD COLUMN short_financing REAL');
    }
    if (!colNames.has('commission')) {
      db.exec('ALTER TABLE clients ADD COLUMN commission REAL');
    }
    if (!colNames.has('commission_cost')) {
      db.exec('ALTER TABLE clients ADD COLUMN commission_cost REAL');
    }
    if (!colNames.has('net_comm')) {
      db.exec('ALTER TABLE clients ADD COLUMN net_comm REAL');
    }
    if (!colNames.has('long_pnl_spread')) {
      db.exec('ALTER TABLE clients ADD COLUMN long_pnl_spread REAL');
    }
    if (!colNames.has('short_pnl_spread')) {
      db.exec('ALTER TABLE clients ADD COLUMN short_pnl_spread REAL');
    }
    if (!colNames.has('index_hedging')) {
      db.exec('ALTER TABLE clients ADD COLUMN index_hedging INTEGER');
    }
  });

  runOnce('remove-pnl-spread-columns', () => {
    const cols = db.pragma('table_info(clients)') as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    if (colNames.has('long_pnl_spread')) {
      db.exec('ALTER TABLE clients DROP COLUMN long_pnl_spread');
    }
    if (colNames.has('short_pnl_spread')) {
      db.exec('ALTER TABLE clients DROP COLUMN short_pnl_spread');
    }
  });

  runOnce('add-is-ft-column', () => {
    const cols = db.pragma('table_info(clients)') as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has('is_ft')) {
      db.exec('ALTER TABLE clients ADD COLUMN is_ft INTEGER NOT NULL DEFAULT 0');
    }
  });

  runOnce('add-pricing-quotes-table', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pricing_quotes (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        quote_type  TEXT NOT NULL,
        quote_date  TEXT NOT NULL,
        file_name   TEXT,
        data        TEXT NOT NULL,
        metadata    TEXT,
        created_by  TEXT NOT NULL REFERENCES users(id),
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pricing_quotes_agent_type
        ON pricing_quotes(agent_id, quote_type, quote_date);
    `);
  });

  runOnce('add-pricing-range-column', () => {
    const cols = db.pragma('table_info(clients)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'pricing_range')) {
      db.exec('ALTER TABLE clients ADD COLUMN pricing_range TEXT');
    }
  });

  runOnce('otcclaw-add-pricing-quote-tools', () => {
    const row = db.prepare("SELECT tools_list FROM agents WHERE name = 'otcclaw'").get() as { tools_list: string | null } | undefined;
    if (!row) return;
    const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    const toAdd = ['import_pricing_quote', 'query_pricing_quote', 'list_pricing_quote_dates'];
    for (const t of toAdd) {
      if (!list.includes(t)) list.push(t);
    }
    db.prepare("UPDATE agents SET tools_list = ?, updated_at = datetime('now') WHERE name = 'otcclaw'")
      .run(JSON.stringify(list));
  });

  /**
   * import_pricing_schedule 历史遗漏：config/agents/otcclaw.md 与 src/runtime/file-hint.ts
   * 都引导 LLM 使用该工具，但 tools_list 从未包含它，导致 agent admin 调用时命中
   * "不在允许列表" 错误。顺带同步进 user blocklist，保持与 add_client/update_client 等写操作一致。
   */
  runOnce('otcclaw-add-import-pricing-schedule', () => {
    const row = db.prepare(
      "SELECT tools_list, user_tools_list FROM agents WHERE name = 'otcclaw'"
    ).get() as { tools_list: string | null; user_tools_list: string | null } | undefined;
    if (!row) return;

    const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    let toolsChanged = false;
    if (!list.includes('import_pricing_schedule')) {
      list.push('import_pricing_schedule');
      toolsChanged = true;
    }

    const userList: string[] = row.user_tools_list ? JSON.parse(row.user_tools_list) : [];
    let userChanged = false;
    if (!userList.includes('import_pricing_schedule')) {
      userList.push('import_pricing_schedule');
      userChanged = true;
    }

    if (toolsChanged || userChanged) {
      db.prepare(
        "UPDATE agents SET tools_list = ?, user_tools_list = ?, updated_at = datetime('now') WHERE name = 'otcclaw'"
      ).run(
        toolsChanged ? JSON.stringify(list) : row.tools_list,
        userChanged ? JSON.stringify(userList) : row.user_tools_list,
      );
    }
  });

  /**
   * 在 drop agents.system_prompt 列之前，把所有非空 prompt 导出到 config/agents/<name>.md，
   * 避免用户通过 save_agent 自定义过的 prompt 在迁移时静默丢失。
   * 仅在目标文件不存在时写入，不覆盖已经手写的 md。
   */
  runOnce('export-agents-system-prompt-to-md', () => {
    const cols = db.pragma('table_info(agents)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'system_prompt')) return;

    const rows = db.prepare(
      "SELECT name, system_prompt FROM agents WHERE system_prompt IS NOT NULL AND TRIM(system_prompt) != ''"
    ).all() as Array<{ name: string; system_prompt: string }>;
    if (rows.length === 0) return;

    const promptsDir = resolve(process.cwd(), 'config/agents');
    fs.mkdirSync(promptsDir, { recursive: true });

    const placeholderBlock = '\n\n{{permissions}}\n\n{{attachments}}\n\n{{skills}}\n\n{{memory}}\n';

    for (const row of rows) {
      const target = join(promptsDir, `${row.name}.md`);
      if (fs.existsSync(target)) continue;
      const body = row.system_prompt.trimEnd();
      fs.writeFileSync(target, body + placeholderBlock, 'utf-8');
      console.log(`[migration] exported agents.system_prompt → ${target}`);
    }
  });

  /**
   * system prompt 迁移到 config/agents/<name>.md 后，删除 agents.system_prompt 列。
   * 优先使用 SQLite 3.35+ 的 `ALTER TABLE ... DROP COLUMN`；不支持则回退到 rebuild 模式。
   */
  runOnce('drop-agents-system-prompt-column', () => {
    const cols = db.pragma('table_info(agents)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'system_prompt')) return;
    try {
      db.exec('ALTER TABLE agents DROP COLUMN system_prompt');
      return;
    } catch (_e) {
      // fall through to rebuild
    }

    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
        CREATE TABLE agents_new (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL UNIQUE,
          display_name  TEXT NOT NULL,
          description   TEXT,
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
      db.exec(`
        INSERT INTO agents_new (id, name, display_name, description, model, provider,
          tools_mode, tools_list, block_tools, preset, user_tools_mode, user_tools_list,
          max_history, created_by, created_at, updated_at)
        SELECT id, name, display_name, description, model, provider,
          tools_mode, tools_list, block_tools, preset, user_tools_mode, user_tools_list,
          max_history, created_by, created_at, updated_at
        FROM agents;
      `);
      db.exec('DROP TABLE agents;');
      db.exec('ALTER TABLE agents_new RENAME TO agents;');
    } finally {
      db.pragma('foreign_keys = ON');
    }
  });

  runOnce('agents-minimax-provider', () => {
    db.prepare(
      `UPDATE agents SET provider = 'minimax', model = 'MiniMax-M2.7-highspeed', updated_at = datetime('now') WHERE name NOT IN ('otcclaw', 'admin')`
    ).run();
  });

  runOnce('agents-deepseek-provider', () => {
    db.prepare(
      `UPDATE agents SET provider = 'deepseek', model = 'deepseek-v4-flash', updated_at = datetime('now') WHERE name NOT IN ('otcclaw', 'admin')`
    ).run();
  });

  // -----------------------------------------------------------------------
  // Migration: document knowledge from DB chunks → Markdown files + grep search
  // -----------------------------------------------------------------------
  runOnce('migrate-doc-knowledge-to-files', () => {
    const documentsRoot = resolve('data/documents');

    // 1. Move document directories from flat to agent-scoped structure
    try {
      const docs = db.prepare('SELECT id, agent_id, stored_path, title, file_type, created_by, created_at FROM documents').all() as { id: string; agent_id: string | null; stored_path: string | null; title: string; file_type: string; created_by: string; created_at: string }[];

      for (const doc of docs) {
        const agentId = doc.agent_id || 'agent-otcclaw';
        const docId8 = doc.id.slice(0, 8);
        const oldDir = join(documentsRoot, docId8);
        const agentDir = join(documentsRoot, agentId);
        const newDir = join(agentDir, docId8);

        if (!fs.existsSync(oldDir)) continue;

        // Create agent directory and move
        fs.mkdirSync(agentDir, { recursive: true });
        if (oldDir !== newDir && !fs.existsSync(newDir)) {
          try {
            // Copy to new location (not rename, since agentDir may not exist yet)
            fs.cpSync(oldDir, newDir, { recursive: true });
            // Remove old directory after successful copy
            fs.rmSync(oldDir, { recursive: true, force: true });
          } catch (e: any) {
            console.warn(`Failed to move ${oldDir} → ${newDir}: ${e.message}`);
          }
        }

        // 2. Inject YAML frontmatter into parsed.md
        const parsedMdPath = join(newDir, 'parsed.md');
        if (fs.existsSync(parsedMdPath)) {
          const content = fs.readFileSync(parsedMdPath, 'utf-8');
          // Skip if already has frontmatter
          if (!content.startsWith('---\n')) {
            const frontmatter = [
              '---',
              `document_id: ${doc.id}`,
              `agent_id: ${agentId}`,
              `title: "${doc.title.replace(/"/g, '\\"')}"`,
              `tags: ${doc.title}`,
              `file_type: ${doc.file_type}`,
              `created_by: ${doc.created_by}`,
              `created_at: ${doc.created_at}`,
              '---',
              '',
            ].join('\n');
            fs.writeFileSync(parsedMdPath, frontmatter + content, 'utf-8');
          }
        }

        // 3. Update stored_path in documents table
        db.prepare('UPDATE documents SET stored_path = ? WHERE id = ?').run(newDir, doc.id);
      }
    } catch (e: any) {
      console.warn(`Document directory migration failed: ${e.message}`);
    }

    // 4. Delete knowledge rows that were document chunks (document_id IS NOT NULL)
    try {
      const result = db.prepare('DELETE FROM knowledge WHERE document_id IS NOT NULL').run();
      console.log(`Deleted ${result.changes} document chunk rows from knowledge table`);
    } catch (e: any) {
      console.warn(`Failed to delete document knowledge rows: ${e.message}`);
    }

    // 5. Clean up orphan directories (no original/parsed files, only images)
    try {
      const entries = fs.readdirSync(documentsRoot);
      for (const entry of entries) {
        const entryPath = join(documentsRoot, entry);
        if (!fs.statSync(entryPath).isDirectory()) continue;

        const children = fs.readdirSync(entryPath);
        const hasSubdirs = children.some((f: string) => fs.statSync(join(entryPath, f)).isDirectory());

        if (hasSubdirs) {
          // Agent-scoped directory (contains doc subdirs) — only prune empty subdirs
          for (const sub of children) {
            const subPath = join(entryPath, sub);
            if (!fs.statSync(subPath).isDirectory()) continue;
            const hasOriginal = fs.readdirSync(subPath).some((f: string) => f.startsWith('original'));
            const hasParsed = fs.readdirSync(subPath).some((f: string) => f.startsWith('parsed'));
            if (!hasOriginal && !hasParsed) {
              fs.rmSync(subPath, { recursive: true, force: true });
            }
          }
        } else {
          // Flat document directory (pre-migration style, e.g. data/documents/<docId8>)
          const hasOriginal = children.some((f: string) => f.startsWith('original'));
          const hasParsed = children.some((f: string) => f.startsWith('parsed'));
          if (!hasOriginal && !hasParsed) {
            fs.rmSync(entryPath, { recursive: true, force: true });
          }
        }
      }
    } catch (e: any) {
      console.warn(`Orphan cleanup failed: ${e.message}`);
    }
  });

  // -----------------------------------------------------------------------
  // Migration v2: finalize documents schema
  //   - add documents.size_bytes column (idempotent via PRAGMA probe)
  //   - backfill size_bytes from parsed.md on disk
  //   - normalize documents.stored_path from absolute → relative
  //     ("data/documents/<agent>/<docId8>"), so deployments / cwd changes
  //     don't break the lookup.
  //   - wrapped in a transaction; rethrows on failure so runOnce does NOT
  //     mark this migration as done (retries on next startup).
  // -----------------------------------------------------------------------
  runOnce('migrate-documents-v2-cleanup', () => {
    const documentsRoot = resolve('data/documents');
    const packageRoot = resolve('.');

    // 1. Probe and add size_bytes column if missing (outside the tx — DDL
    //    in SQLite implicitly commits the current transaction on some
    //    builds; doing it first keeps the data update atomic).
    const columns = db.prepare(`PRAGMA table_info('documents')`).all() as { name: string }[];
    const hasSizeBytes = columns.some(c => c.name === 'size_bytes');
    if (!hasSizeBytes) {
      db.exec(`ALTER TABLE documents ADD COLUMN size_bytes INTEGER`);
    }

    // 2. In a single transaction: walk all documents, compute size, normalize path.
    const tx = db.transaction(() => {
      const docs = db.prepare(
        'SELECT id, agent_id, stored_path FROM documents',
      ).all() as { id: string; agent_id: string | null; stored_path: string | null }[];

      const updateStmt = db.prepare(
        'UPDATE documents SET stored_path = ?, size_bytes = ? WHERE id = ?',
      );

      for (const doc of docs) {
        // Compute absolute stored dir
        let absDir: string | null = null;
        if (doc.stored_path) {
          absDir = isAbsolute(doc.stored_path)
            ? doc.stored_path
            : resolve(packageRoot, doc.stored_path);
        } else if (doc.agent_id) {
          absDir = join(documentsRoot, doc.agent_id, doc.id.slice(0, 8));
        }

        // Derive relative path for DB
        let newStoredPath: string | null = doc.stored_path;
        if (absDir) {
          const rel = relative(packageRoot, absDir).split(sep).join('/');
          if (rel && !rel.startsWith('..')) newStoredPath = rel;
        }

        // Compute size_bytes from parsed.md (skip if missing)
        let sizeBytes: number | null = null;
        if (absDir) {
          const mdPath = join(absDir, 'parsed.md');
          if (fs.existsSync(mdPath)) {
            try {
              sizeBytes = fs.statSync(mdPath).size;
            } catch { /* keep null */ }
          }
        }

        if (newStoredPath !== doc.stored_path || sizeBytes !== null) {
          updateStmt.run(newStoredPath, sizeBytes, doc.id);
        }
      }
    });

    tx();
  });

  // Migration v3: use agent.name (human-readable) instead of agent.id (UUID)
  // for filesystem directories under data/documents/. Updates stored_path
  // in the DB and moves directories on disk.
  runOnce('migrate-documents-use-agent-name', () => {
    const documentsRoot = resolve('data/documents');
    const packageRoot = resolve('.');

    const tx = db.transaction(() => {
      const docs = db.prepare(
        'SELECT d.id, d.agent_id, d.stored_path, a.name as agent_name FROM documents d LEFT JOIN agents a ON d.agent_id = a.id WHERE d.agent_id IS NOT NULL',
      ).all() as { id: string; agent_id: string; stored_path: string | null; agent_name: string | null }[];

      let moved = 0;
      let updated = 0;

      for (const doc of docs) {
        const agentName = doc.agent_name || doc.agent_id;
        if (agentName === doc.agent_id) continue; // already using id==name, nothing to migrate

        const oldDocId8 = doc.id.slice(0, 8);

        // Resolve old absolute dir
        let oldAbsDir: string;
        if (doc.stored_path) {
          oldAbsDir = isAbsolute(doc.stored_path)
            ? doc.stored_path
            : resolve(packageRoot, doc.stored_path);
        } else {
          oldAbsDir = join(documentsRoot, doc.agent_id, oldDocId8);
        }

        // New absolute dir
        const newAbsDir = join(documentsRoot, agentName, oldDocId8);

        // Move directory on disk
        if (fs.existsSync(oldAbsDir) && !fs.existsSync(newAbsDir)) {
          fs.mkdirSync(join(documentsRoot, agentName), { recursive: true });
          fs.renameSync(oldAbsDir, newAbsDir);
          moved++;
        }

        // Update stored_path in DB
        const relPath = relative(packageRoot, newAbsDir).split(sep).join('/');
        if (relPath && !relPath.startsWith('..')) {
          db.prepare('UPDATE documents SET stored_path = ? WHERE id = ?').run(relPath, doc.id);
          updated++;
        }
      }

      if (moved > 0 || updated > 0) {
        console.log(`[migrate-documents-use-agent-name] moved ${moved} dirs, updated ${updated} stored_path rows`);
      }
    });

    tx();
  });

  runOnce('otcclaw-rename-display-name', () => {
    db.prepare("UPDATE agents SET display_name = '衍语', updated_at = datetime('now') WHERE name = 'otcclaw' AND display_name = '衍语助手'").run();
  });

  runOnce('otcclaw-add-export-trades-csv', () => {
    const row = db.prepare("SELECT tools_list FROM agents WHERE name = 'otcclaw'").get() as { tools_list: string | null } | undefined;
    if (!row) return;
    const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    if (!list.includes('export_trades_csv')) {
      list.push('export_trades_csv');
      db.prepare("UPDATE agents SET tools_list = ?, updated_at = datetime('now') WHERE name = 'otcclaw'")
        .run(JSON.stringify(list));
    }
  });

  runOnce('add-wrong-questions-tables', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wrong_questions (
        id                 TEXT PRIMARY KEY,
        agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subject            TEXT NOT NULL CHECK(subject IN ('math', 'chinese', 'english', 'science')),
        question_summary   TEXT NOT NULL,
        wrong_answer       TEXT,
        expected_direction TEXT,
        error_type         TEXT NOT NULL DEFAULT 'knowledge' CHECK(error_type IN ('knowledge', 'logic')),
        error_subtype      TEXT,
        analysis           TEXT,
        status             TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'mastered')),
        mistake_count      INTEGER NOT NULL DEFAULT 1,
        source_type        TEXT NOT NULL DEFAULT 'text' CHECK(source_type IN ('text', 'image', 'document')),
        storage_dir        TEXT,
        created_by         TEXT NOT NULL REFERENCES users(id),
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
        last_wrong_at      TEXT NOT NULL DEFAULT (datetime('now')),
        mastered_at        TEXT
      );

      CREATE TABLE IF NOT EXISTS wrong_question_assets (
        id                TEXT PRIMARY KEY,
        wrong_question_id TEXT NOT NULL REFERENCES wrong_questions(id) ON DELETE CASCADE,
        asset_role        TEXT NOT NULL DEFAULT 'original'
                            CHECK(asset_role IN ('original', 'annotated', 'cropped', 'ocr')),
        file_name         TEXT NOT NULL,
        file_ext          TEXT,
        mime_type         TEXT,
        size_bytes        INTEGER,
        stored_path       TEXT NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_wrong_questions_agent_user_status
        ON wrong_questions(agent_id, user_id, status);
      CREATE INDEX IF NOT EXISTS idx_wrong_questions_agent_user_subject
        ON wrong_questions(agent_id, user_id, subject);
      CREATE INDEX IF NOT EXISTS idx_wrong_question_assets_question_role
        ON wrong_question_assets(wrong_question_id, asset_role);
    `);
  });

  runOnce('tutor-add-wrong-question-tools', () => {
    const toolNames = [
      'record_wrong_question',
      'list_wrong_questions',
      'mark_wrong_question_mastered',
      'wrong_question_report',
    ];
    const row = db.prepare("SELECT tools_list FROM agents WHERE name = 'tutor'").get() as { tools_list: string | null } | undefined;
    if (!row) return;
    const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    let changed = false;
    for (const tool of toolNames) {
      if (!list.includes(tool)) {
        list.push(tool);
        changed = true;
      }
    }
    if (changed) {
      db.prepare("UPDATE agents SET tools_list = ?, updated_at = datetime('now') WHERE name = 'tutor'")
        .run(JSON.stringify(list));
    }
  });

  runOnce('agents-rename-glm-to-gf', () => {
    db.prepare("UPDATE agents SET provider = 'gf', updated_at = datetime('now') WHERE provider = 'glm'").run();
  });

  runOnce('add-telemetry-turn-table', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_turn (
        turn_id         TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        agent_id        TEXT NOT NULL,
        channel         TEXT NOT NULL,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER NOT NULL,
        ctx_ms          INTEGER NOT NULL DEFAULT 0,
        llm_total_ms    INTEGER NOT NULL DEFAULT 0,
        tool_total_ms   INTEGER NOT NULL DEFAULT 0,
        render_ms       INTEGER NOT NULL DEFAULT 0,
        loop_rounds     INTEGER NOT NULL DEFAULT 1,
        total_tool_calls INTEGER NOT NULL DEFAULT 0,
        stop_reason     TEXT NOT NULL DEFAULT '',
        model           TEXT NOT NULL DEFAULT '',
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        tools_json      TEXT NOT NULL DEFAULT '[]',
        llm_calls_json  TEXT NOT NULL DEFAULT '[]',
        knowledge_hits_json TEXT NOT NULL DEFAULT '[]',
        user_question   TEXT NOT NULL DEFAULT '',
        answer_preview  TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_turn_session ON telemetry_turn(session_id);
      CREATE INDEX IF NOT EXISTS idx_telemetry_turn_agent ON telemetry_turn(agent_id);
      CREATE INDEX IF NOT EXISTS idx_telemetry_turn_started ON telemetry_turn(started_at);
      CREATE INDEX IF NOT EXISTS idx_telemetry_turn_channel ON telemetry_turn(channel);
    `);
  });

  runOnce('otcclaw-add-sandbox-tools', () => {
    const row = db.prepare(
      "SELECT tools_list FROM agents WHERE name = 'otcclaw'"
    ).get() as { tools_list: string | null } | undefined;
    if (!row) return;

    const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    let changed = false;
    for (const t of ['sandbox_write_file', 'sandbox_read_file', 'sandbox_list', 'sandbox_exec']) {
      if (!list.includes(t)) { list.push(t); changed = true; }
    }

    if (changed) {
      db.prepare(
        "UPDATE agents SET tools_list = ?, updated_at = datetime('now') WHERE name = 'otcclaw'"
      ).run(JSON.stringify(list));
    }
  });

  runOnce('add-documents-content-hash', () => {
    try { db.exec("ALTER TABLE documents ADD COLUMN content_hash TEXT"); } catch (e) {}
  });

  runOnce('add-documents-doc-date', () => {
    try { db.exec("ALTER TABLE documents ADD COLUMN doc_date TEXT"); } catch (e) {}
  });

  /**
   * Backfill content_hash for existing documents by hashing the stored original file.
   * Falls back to the source_path if original copy is unavailable on disk.
   */
  runOnce('backfill-documents-content-hash', () => {
    const docs = db.prepare(
      "SELECT id, source_path, stored_path, file_type FROM documents WHERE content_hash IS NULL"
    ).all() as { id: string; source_path: string; stored_path: string | null; file_type: string }[];

    const updateStmt = db.prepare("UPDATE documents SET content_hash = ? WHERE id = ?");
    let ok = 0;
    let skipped = 0;

    for (const doc of docs) {
      let filePath: string | null = null;

      // Try stored original copy first
      if (doc.stored_path) {
        const ext = extname(doc.source_path) || '.bin';
        const absDir = isAbsolute(doc.stored_path)
          ? doc.stored_path
          : resolve('.', doc.stored_path);
        const originalPath = join(absDir, `original${ext}`);
        if (fs.existsSync(originalPath)) {
          filePath = originalPath;
        }
      }

      // Fallback: try source_path itself
      if (!filePath && doc.source_path && fs.existsSync(doc.source_path)) {
        filePath = doc.source_path;
      }

      if (filePath) {
        try {
          const hash = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
          updateStmt.run(hash, doc.id);
          ok++;
        } catch {
          skipped++;
        }
      } else {
        skipped++;
      }
    }

    if (ok > 0 || skipped > 0) {
      console.log(`[backfill-documents-content-hash] ok=${ok} skipped=${skipped}`);
    }
  });

  runOnce('seed-ticlaw-agent', () => {
    const botId = 'aibVpgqdRX0aRtfu0351LN-Ehtu9BVzSmMo';

    // Agent — use name-based lookup so we don't depend on a hardcoded id
    let agentId: string;
    const agentRow = db.prepare("SELECT id FROM agents WHERE name = 'ticlaw'").get() as { id: string } | undefined;
    if (agentRow) {
      agentId = agentRow.id;
    } else {
      agentId = 'agent-ticlaw';
      db.prepare(
        'INSERT INTO agents (id, name, display_name, description, tools_mode, tools_list, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(agentId, 'ticlaw', 'TIClaw', 'Titans系统全能助理，知晓一切业务需求细节，了解系统架构，能清晰将代码与需求关联起来，并能敏锐觉察可能存在的系统缺陷', 'standard', JSON.stringify(TICLAW_EXTRA_TOOLS), 'admin-001');
      console.log('[seed-ticlaw-agent] Agent created');
    }

    // Bot app
    const botExists = db.prepare("SELECT 1 FROM bot_apps WHERE id = ?").get(botId);
    if (!botExists) {
      db.prepare(
        'INSERT INTO bot_apps (id, channel, name, secret, config, show_thinking, auto_start) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(botId, 'wework', 'ticlaw-bot', 'YsXcl1XvqQ2NlV3YXRAsArKOYgctrUXkEKF86G0YiG2', '{}', 1, 1);
      console.log('[seed-ticlaw-agent] Bot app created');
    }

    // Agent membership for admin
    const memberExists = db.prepare("SELECT 1 FROM agent_members WHERE agent_id = ? AND user_id = 'admin-001'").get(agentId);
    if (!memberExists) {
      db.prepare("INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)")
        .run(uuid(), agentId, 'admin-001', 'admin');
    }

    // Agent assignment: bind agent to bot
    const assignExists = db.prepare("SELECT 1 FROM agent_assignments WHERE agent_id = ? AND channel = 'wework'").get(agentId);
    if (!assignExists) {
      db.prepare("INSERT OR IGNORE INTO agent_assignments (id, agent_id, channel, app_id) VALUES (?, ?, ?, ?)")
        .run(uuid(), agentId, 'wework', botId);
      console.log('[seed-ticlaw-agent] Agent bound to WeWork bot');
    }

    console.log('[seed-ticlaw-agent] Done');
  });

  runOnce('fix-ticlaw-agent-id', () => {
    // Fix any pre-existing ticlaw agent that may have a UUID id (from a partial earlier run)
    // Normalise to 'agent-ticlaw' so future migrations can reference it predictably.
    const row = db.prepare("SELECT id FROM agents WHERE name = 'ticlaw'").get() as { id: string } | undefined;
    if (!row) return;
    if (row.id === 'agent-ticlaw') return;

    const standardId = 'agent-ticlaw';
    // Update FK references
    db.prepare("UPDATE agent_members SET agent_id = ? WHERE agent_id = ?").run(standardId, row.id);
    db.prepare("UPDATE agent_assignments SET agent_id = ? WHERE agent_id = ?").run(standardId, row.id);
    // Update the agent itself (disable FK pragma required for self-referencing PK update)
    db.pragma('foreign_keys = OFF');
    db.prepare("UPDATE agents SET id = ? WHERE id = ?").run(standardId, row.id);
    db.pragma('foreign_keys = ON');
    console.log(`[fix-ticlaw-agent-id] Normalised agent id ${row.id} → ${standardId}`);
  });

  runOnce('ticlaw-standard-tools', () => {
    // Switch ticlaw from 'all' to 'standard' mode with system tools only (no client/trade/health/pricing/hedge/wework)
    const row = db.prepare("SELECT id, tools_mode, tools_list FROM agents WHERE name = 'ticlaw'").get() as { id: string; tools_mode: string; tools_list: string | null } | undefined;
    if (!row) return;
    if (row.tools_mode === 'standard' && row.tools_list) return; // already migrated
    db.prepare("UPDATE agents SET tools_mode = 'standard', tools_list = ?, block_tools = NULL, updated_at = datetime('now') WHERE name = 'ticlaw'")
      .run(JSON.stringify(TICLAW_EXTRA_TOOLS));
    console.log('[ticlaw-standard-tools] Switched to standard mode');
  });

  runOnce('otcclaw-add-export-north-info-csv', () => {
    const row = db.prepare("SELECT tools_list FROM agents WHERE name = 'otcclaw'").get() as { tools_list: string | null } | undefined;
    if (!row) return;
    const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    if (!list.includes('export_north_info_csv')) {
      list.push('export_north_info_csv');
      db.prepare("UPDATE agents SET tools_list = ?, updated_at = datetime('now') WHERE name = 'otcclaw'")
        .run(JSON.stringify(list));
    }
  });

  /**
   * Grant otcclaw read_file with agent-level allowlist gate.
   * Allowlist lives in config/agents/otcclaw.files.json (committed alongside this migration).
   * Also removes read_file from user_tools_list (member blocklist) — historically blocked
   * because read_file had no auth check; the new allowlist now bounds what non-admins can read.
   */
  runOnce('otcclaw-add-read-file', () => {
    const row = db.prepare(
      "SELECT tools_list, user_tools_list FROM agents WHERE name = 'otcclaw'"
    ).get() as { tools_list: string | null; user_tools_list: string | null } | undefined;
    if (!row) return;

    const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    const userList: string[] = row.user_tools_list ? JSON.parse(row.user_tools_list) : [];

    let changed = false;
    if (!list.includes('read_file')) {
      list.push('read_file');
      changed = true;
    }
    const ufIdx = userList.indexOf('read_file');
    if (ufIdx !== -1) {
      userList.splice(ufIdx, 1);
      changed = true;
    }

    if (changed) {
      db.prepare(
        "UPDATE agents SET tools_list = ?, user_tools_list = ?, updated_at = datetime('now') WHERE name = 'otcclaw'"
      ).run(JSON.stringify(list), userList.length > 0 ? JSON.stringify(userList) : null);
    }
  });

  /**
   * ticlaw: read_file allowlist (config/agents/ticlaw.files.json) + sandbox .data/ mount for Wind docs.
   * Removes read_file from member blocklist like otcclaw-add-read-file; defensively merges sandbox tools.
   */
  runOnce('ticlaw-add-read-file-wind', () => {
    const row = db.prepare(
      "SELECT tools_list, user_tools_list FROM agents WHERE name = 'ticlaw'",
    ).get() as { tools_list: string | null; user_tools_list: string | null } | undefined;
    if (!row) return;

    const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    const userList: string[] = row.user_tools_list ? JSON.parse(row.user_tools_list) : [];

    let changed = false;
    for (const t of ['sandbox_write_file', 'sandbox_read_file', 'sandbox_list', 'sandbox_exec', 'read_file']) {
      if (!list.includes(t)) {
        list.push(t);
        changed = true;
      }
    }
    const rfIdx = userList.indexOf('read_file');
    if (rfIdx !== -1) {
      userList.splice(rfIdx, 1);
      changed = true;
    }

    if (changed) {
      db.prepare(
        "UPDATE agents SET tools_list = ?, user_tools_list = ?, updated_at = datetime('now') WHERE name = 'ticlaw'",
      ).run(JSON.stringify(list), userList.length > 0 ? JSON.stringify(userList) : null);
    }
  });

  runOnce('potato-add-sandbox-tools', () => {
    const row = db.prepare(
      "SELECT tools_list, user_tools_list FROM agents WHERE name = 'potato'"
    ).get() as { tools_list: string | null; user_tools_list: string | null } | undefined;
    if (!row) return;

    const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    const userList: string[] = row.user_tools_list ? JSON.parse(row.user_tools_list) : [];

    let changed = false;
    for (const t of ['sandbox_write_file', 'sandbox_read_file', 'sandbox_list', 'sandbox_exec', 'read_file']) {
      if (!list.includes(t)) { list.push(t); changed = true; }
    }
    const rfIdx = userList.indexOf('read_file');
    if (rfIdx !== -1) {
      userList.splice(rfIdx, 1);
      changed = true;
    }

    if (changed) {
      db.prepare(
        "UPDATE agents SET tools_list = ?, user_tools_list = ?, updated_at = datetime('now') WHERE name = 'potato'"
      ).run(JSON.stringify(list), userList.length > 0 ? JSON.stringify(userList) : null);
    }
  });

  runOnce('add-documents-wiki-compiled-hash', () => {
    try { db.exec("ALTER TABLE documents ADD COLUMN wiki_compiled_hash TEXT"); } catch (e) {}
  });

  runOnce('add-telemetry-user-question', () => {
    const col = db.prepare("PRAGMA table_info(telemetry_turn)").all() as { name: string }[];
    if (!col.some(c => c.name === 'user_question')) {
      db.prepare("ALTER TABLE telemetry_turn ADD COLUMN user_question TEXT NOT NULL DEFAULT ''").run();
    }
  });

  // --- Users display_name ---

  runOnce('add-users-display-name', () => {
    try { db.exec("ALTER TABLE users ADD COLUMN display_name TEXT"); } catch (e) {}

    const knownNames: [string, string][] = [
      ['wework_gzxujun', '许骏'],
      ['wework_zhaoqingyu', '赵晴宇'],
      ['wework_petershen', 'Peter Shen'],
      ['wework_aprilyan', 'April Yan'],
      ['wework_nicolasong', 'Nicolas Song'],
      ['wework_nicoleqiu', 'Nicole Qiu'],
      ['wework_kevinyin', 'Kevin Yin'],
      ['wework_stevenlu', 'Steven Lu'],
      ['wework_sunbin', '孙滨'],
      ['wework_sunxian', '孙娴'],
      ['wework_dongshengli', '董胜利'],
      ['wework_guoxiaoyu', '郭晓瑜'],
      ['wework_gzyuyang', '郁泱'],
      ['wework_hkyangyige', '杨易歌'],
      ['wework_huangxiaoyi', '黄晓怡'],
      ['wework_luanyinan', '栾宜男'],
      ['wework_lvruonan', '吕若楠'],
      ['wework_chenwanqian', '陈婉茜'],
      ['wework_fuhangrui', '符航睿'],
      ['wework_gfguozhi', '郭智'],
      ['wework_jiakunyou', '由嘉坤'],
      ['wework_shanchuwen', '单楚文'],
      ['wework_wangxingqiang', '王兴强'],
      ['wework_weikunhuang', '黄伟琨'],
      ['feishu_ou_0e6cf7a054dc5629fa4bb4209236f292', '许骏'],
      ['feishu_ou_7e6c4bfcb6a25a9909bd2fe4e7ad3230', '许骏'],
      ['feishu_ou_b5fcfc05455cdca7c4f934b8443bbf9c', '丁丁'],
      ['feishu_ou_dad1044cedcb817cd0a4f96f7183b603', '多米'],
    ];
    const stmt = db.prepare("UPDATE users SET display_name = ? WHERE id = ? AND display_name IS NULL");
    for (const [id, name] of knownNames) {
      stmt.run(name, id);
    }
  });

  runOnce('add-external-wework-display-names', () => {
    const names: [string, string][] = [
      ['wework_wofvtgBgAAnfJpH24lr99a5QoP3QinaQ', '许骏'],
      ['wework_wofvtgBgAA5XodEfNkoiCJxi077bfgSA', '栾宜男'],
      ['wework_wofvtgBgAA_evLaVToUX0IP8-cLCLJBA', '刘航伸'],
      ['wework_wofvtgBgAAzcWhWop8HVoPE7iJu-vAxQ', '孙滨'],
      ['wework_wofvtgBgAAAqc2sq0LTddNVMSLms2GMw', '熊周桥'],
      ['wework_wofvtgBgAAlmOGj8zeXvQTeF1uHJSp6w', '唐洋'],
    ];
    const stmt = db.prepare("UPDATE users SET display_name = ? WHERE id = ? AND display_name IS NULL");
    for (const [id, name] of names) {
      stmt.run(name, id);
    }
    db.prepare("UPDATE users SET display_name = '孙滨' WHERE id = 'wework_sunbin'").run();
  });

  // --- 测试环境：关闭生产 wework bot，新增测试 bot 绑定 otcclaw ---

  runOnce('wework-test-bot-setup', () => {
    // 1. 关闭现有 wework bot 的 auto_start（生产 otcclaw + ticlaw）
    db.prepare("UPDATE bot_apps SET auto_start = 0 WHERE channel = 'wework'").run();

    // 2. 注册测试 bot
    const testBotId = 'aib-l7p7MyNNEpadH2ELbHpZ0ozjczqiaWE';
    const testSecret = '4qra3bvf4bCZW8VAL6yWnPMhNupyRSQc6HAMCGneZd2';
    const exists = db.prepare('SELECT 1 FROM bot_apps WHERE id = ?').get(testBotId);
    if (!exists) {
      db.prepare(
        'INSERT INTO bot_apps (id, channel, name, secret, config, show_thinking, auto_start) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(testBotId, 'wework', 'otcclaw-test-bot', testSecret, '{}', 1, 1);
    } else {
      db.prepare('UPDATE bot_apps SET auto_start = 1 WHERE id = ?').run(testBotId);
    }

    // 3. 绑定测试 bot → otcclaw agent
    const agentRow = db.prepare("SELECT id FROM agents WHERE name = 'otcclaw'").get() as { id: string } | undefined;
    if (agentRow) {
      const assignExists = db.prepare("SELECT 1 FROM agent_assignments WHERE channel = 'wework' AND app_id = ?").get(testBotId);
      if (!assignExists) {
        db.prepare("INSERT INTO agent_assignments (id, agent_id, channel, app_id) VALUES (?, ?, ?, ?)")
          .run(uuid(), agentRow.id, 'wework', testBotId);
      }
    }
  });

  // --- Scheduled tasks & crontab tools ---

  // Add crontab tools to all standard-mode agents' tools_list,
  // and add write tools (crontab + scheduled task mutations) to user_tools_list blocklist.
  runOnce('add-schedule-and-crontab-tools', () => {
    const crontabTools = ['list_crontab', 'add_crontab', 'remove_crontab'];
    const writeToolsToBlock = ['add_crontab', 'remove_crontab', 'create_scheduled_task', 'update_scheduled_task', 'delete_scheduled_task'];

    const rows = db.prepare(
      "SELECT name, tools_mode, tools_list, user_tools_list FROM agents"
    ).all() as { name: string; tools_mode: string; tools_list: string | null; user_tools_list: string | null }[];

    for (const row of rows) {
      const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
      const userList: string[] = row.user_tools_list ? JSON.parse(row.user_tools_list) : [];
      let changed = false;

      // Add crontab tools to tools_list (for standard-mode agents; 'all' agents see everything already)
      if (row.tools_mode === 'standard') {
        for (const t of crontabTools) {
          if (!list.includes(t)) { list.push(t); changed = true; }
        }
      }

      // Add write tools to user blocklist
      for (const t of writeToolsToBlock) {
        if (!userList.includes(t)) { userList.push(t); changed = true; }
      }

      if (changed) {
        db.prepare(
          "UPDATE agents SET tools_list = ?, user_tools_list = ?, updated_at = datetime('now') WHERE name = ?"
        ).run(JSON.stringify(list), JSON.stringify(userList), row.name);
      }
    }
  });

  runOnce('agents-add-custom-prompt', () => {
    try { db.exec("ALTER TABLE agents ADD COLUMN custom_prompt TEXT"); } catch {}
  });
}
