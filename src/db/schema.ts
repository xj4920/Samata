import { getDb } from './connection.js';

export function initSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE,
      role       TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_aliases (
      alias_user_id     TEXT PRIMARY KEY,
      canonical_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      note              TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_aliases_canonical ON user_aliases(canonical_user_id);

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
      long_financing_spread REAL,
      short_financing REAL,
      commission REAL,
      commission_cost REAL,
      net_comm REAL,
      index_hedging INTEGER,
      is_ft INTEGER NOT NULL DEFAULT 0,
      pricing_range TEXT,
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
      document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
      created_by   TEXT NOT NULL REFERENCES users(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skills (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      description TEXT,
      agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_by  TEXT NOT NULL REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
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
      custom_prompt TEXT,
      created_by    TEXT NOT NULL REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_assignments (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      channel    TEXT NOT NULL,
      app_id     TEXT,
      target_id  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(channel, app_id, target_id)
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
      auto_start         INTEGER NOT NULL DEFAULT 1,
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

    CREATE TABLE IF NOT EXISTS documents (
      id                 TEXT PRIMARY KEY,
      title              TEXT NOT NULL,
      source_path        TEXT NOT NULL,
      file_type          TEXT NOT NULL,
      chunk_count        INTEGER NOT NULL DEFAULT 0,
      agent_id           TEXT REFERENCES agents(id) ON DELETE CASCADE,
      created_by         TEXT NOT NULL REFERENCES users(id),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      stored_path        TEXT,
      size_bytes         INTEGER,
      content_hash       TEXT,
      doc_date           TEXT,
      wiki_compiled_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      name        TEXT NOT NULL,
      cron_expr   TEXT NOT NULL,
      task_type   TEXT NOT NULL CHECK(task_type IN ('remind', 'sandbox_exec', 'tool_call', 'agent_chat')),
      payload     TEXT NOT NULL,
      channel     TEXT NOT NULL,
      target_id   TEXT,
      app_id      TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      locked_until INTEGER,
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
      user_question_content TEXT NOT NULL DEFAULT '',
      answer_content  TEXT NOT NULL DEFAULT '',
      user_question_chars INTEGER NOT NULL DEFAULT 0,
      answer_chars    INTEGER NOT NULL DEFAULT 0,
      user_question_truncated INTEGER NOT NULL DEFAULT 0,
      answer_truncated INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS answer_feedback (
      feedback_id        TEXT PRIMARY KEY,
      turn_id            TEXT,
      user_id            TEXT NOT NULL,
      clicked_by_user_id TEXT,
      agent_id           TEXT NOT NULL,
      channel            TEXT NOT NULL,
      app_id             TEXT,
      chat_id            TEXT,
      rating             TEXT NOT NULL DEFAULT 'pending'
                         CHECK(rating IN ('pending', 'helpful', 'not_helpful')),
      status             TEXT NOT NULL DEFAULT 'open'
                         CHECK(status IN ('open', 'recorded')),
      question_preview   TEXT NOT NULL DEFAULT '',
      answer_preview     TEXT NOT NULL DEFAULT '',
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_question ON knowledge(question);
    CREATE UNIQUE INDEX IF NOT EXISTS skills_name_agent_unique ON skills(name, COALESCE(agent_id, ''));
    CREATE INDEX IF NOT EXISTS idx_pricing_quotes_agent_type ON pricing_quotes(agent_id, quote_type, quote_date);
    CREATE INDEX IF NOT EXISTS idx_wrong_questions_agent_user_status ON wrong_questions(agent_id, user_id, status);
    CREATE INDEX IF NOT EXISTS idx_wrong_questions_agent_user_subject ON wrong_questions(agent_id, user_id, subject);
    CREATE INDEX IF NOT EXISTS idx_wrong_question_assets_question_role ON wrong_question_assets(wrong_question_id, asset_role);
    CREATE INDEX IF NOT EXISTS idx_telemetry_turn_session ON telemetry_turn(session_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_turn_agent ON telemetry_turn(agent_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_turn_started ON telemetry_turn(started_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_turn_channel ON telemetry_turn(channel);
    CREATE INDEX IF NOT EXISTS idx_answer_feedback_turn ON answer_feedback(turn_id);
    CREATE INDEX IF NOT EXISTS idx_answer_feedback_agent ON answer_feedback(agent_id);
    CREATE INDEX IF NOT EXISTS idx_answer_feedback_status ON answer_feedback(status);
    CREATE INDEX IF NOT EXISTS idx_answer_feedback_created ON answer_feedback(created_at);
  `);

  ensurePlatformBootstrap();
}

function ensurePlatformBootstrap(): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO users (id, username, role)
    VALUES ('admin-001', 'admin', 'admin')
    ON CONFLICT(id) DO UPDATE SET username = excluded.username, role = excluded.role
  `).run();

  db.prepare(`
    INSERT OR IGNORE INTO agents (
      id, name, display_name, description, tools_mode, tools_list, block_tools,
      user_tools_mode, user_tools_list, max_history, created_by
    )
    VALUES (
      'agent-admin', 'admin', '系统管理员', 'CLI 系统管理与生产自举', 'all', NULL, '[]',
      'inherit', NULL, 80, 'admin-001'
    )
  `).run();

  db.prepare(`
    UPDATE agents
    SET tools_mode = 'all',
        tools_list = NULL,
        block_tools = '[]',
        updated_at = datetime('now')
    WHERE name = 'admin'
  `).run();

  const agent = db.prepare("SELECT id FROM agents WHERE name = 'admin'").get() as { id: string } | undefined;
  if (!agent) return;

  db.prepare(`
    INSERT OR IGNORE INTO agent_members (id, agent_id, user_id, role)
    VALUES ('agent-admin-admin-001', ?, 'admin-001', 'admin')
  `).run(agent.id);
}

export async function initDatabase(): Promise<void> {
  initSchema();
  const { runMigrations } = await import('./migrate.js');
  await runMigrations();
}
