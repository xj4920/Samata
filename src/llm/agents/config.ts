import { getDb } from '../../db/connection.js';
import { getCurrentUser, isSystemAdmin, isAgentAdmin } from '../../auth/rbac.js';
import { recordEvent } from '../../models/event.js';
import { v4 as uuid } from 'uuid';
import { log } from '../../utils/logger.js';
import { getExecutionChannel } from '../../runtime/execution-context.js';
import { getPluginTools } from '../../plugins/registry.js';
import { getMcpTools } from '../../services/mcp-manager.js';

/**
 * Base tool set shared by all agents in 'standard' mode.
 * Agent effective tools = (COMMON_SET ∪ allow_tools) \ block_tools
 */
export const COMMON_SET = new Set([
  // Knowledge
  'search_knowledge', 'add_knowledge', 'update_knowledge', 'delete_knowledge', 'list_knowledge_recent',
  // Skill
  'list_skills', 'get_skill', 'save_skill', 'delete_skill', 'run_skill',
  // System
  'get_status_summary',
  // Memory
  'save_memory', 'search_memory', 'delete_memory',
  // Delivery
  'write_artifact', 'send_file', 'send_image',
  // Reminder
  'set_reminder', 'list_reminders', 'cancel_reminder',
  // Todo
  'create_todo', 'list_todos', 'update_todo', 'delete_todo',
  // Media
  'generate_image', 'generate_video',
  // Document
  'import_document', 'list_documents', 'delete_document',
  // Date
  'calculate_date',
]);

/** Native tools that must only be visible to a single agent instance. */
const AGENT_EXCLUSIVE_TOOLS: Record<string, string> = {
  record_wrong_question: 'tutor',
  list_wrong_questions: 'tutor',
  mark_wrong_question_mastered: 'tutor',
  wrong_question_report: 'tutor',
};

/** @deprecated Kept for backward compatibility with list_tool_presets and CLI create wizard. Use COMMON_SET + allow/block instead. */
export const TOOL_PRESETS: Record<string, { description: string; tools: string[] }> = {
  common: {
    description: '通用基础工具集（COMMON_SET）',
    tools: [...COMMON_SET],
  },
  browser: {
    description: '浏览器助手：通过 Chrome DevTools MCP 进行网页浏览、调试、性能分析',
    tools: [
      'mcp_devtools_navigate_page', 'mcp_devtools_list_pages', 'mcp_devtools_select_page',
      'mcp_devtools_new_page', 'mcp_devtools_close_page', 'mcp_devtools_wait_for',
      'mcp_devtools_click', 'mcp_devtools_fill', 'mcp_devtools_fill_form',
      'mcp_devtools_type_text', 'mcp_devtools_press_key', 'mcp_devtools_hover',
      'mcp_devtools_take_screenshot', 'mcp_devtools_take_snapshot',
      'mcp_devtools_evaluate_script', 'mcp_devtools_list_console_messages',
      'mcp_devtools_get_console_message', 'mcp_devtools_lighthouse_audit',
      'mcp_devtools_list_network_requests', 'mcp_devtools_get_network_request',
      'mcp_devtools_performance_start_trace', 'mcp_devtools_performance_stop_trace',
      'mcp_devtools_performance_analyze_insight',
      'mcp_devtools_take_memory_snapshot',
      'mcp_devtools_emulate', 'mcp_devtools_resize_page',
      'search_knowledge', 'get_status_summary',
    ],
  },
};

export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  model?: string;
  provider?: string;
  toolsMode: 'all' | 'standard' | 'allowlist' | 'blocklist';
  /** In 'standard' mode: extra tools beyond COMMON_SET. In legacy 'allowlist'/'blocklist': the tool list. */
  toolsList: string[];
  blockTools: string[];
  /** @deprecated Preset no longer participates in tool computation. Kept for backward compat. */
  preset?: string;
  userToolsMode: 'inherit' | 'all' | 'allowlist' | 'blocklist';
  userToolsList: string[];
  maxHistory: number;
}

/** Code-level fallback when DB has no agents */
const DEFAULT_AGENT: AgentConfig = {
  id: 'default',
  name: 'otcclaw',
  displayName: '衍语',
  description: 'OTC 业务专家',
  toolsMode: 'standard',
  toolsList: [],
  blockTools: [],
  userToolsMode: 'inherit',
  userToolsList: [],
  maxHistory: 80,
};

interface AgentRow {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  model: string | null;
  provider: string | null;
  tools_mode: string;
  tools_list: string | null;
  block_tools: string | null;
  preset: string | null;
  user_tools_mode: string;
  user_tools_list: string | null;
  max_history: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function rowToConfig(row: AgentRow): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description ?? undefined,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    toolsMode: row.tools_mode as AgentConfig['toolsMode'],
    toolsList: row.tools_list ? JSON.parse(row.tools_list) : [],
    blockTools: row.block_tools ? JSON.parse(row.block_tools) : [],
    preset: row.preset ?? undefined,
    userToolsMode: (row.user_tools_mode ?? 'inherit') as AgentConfig['userToolsMode'],
    userToolsList: row.user_tools_list ? JSON.parse(row.user_tools_list) : [],
    maxHistory: row.max_history,
  };
}

export function getAgent(name: string): AgentConfig {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRow | undefined;
  if (!row) return DEFAULT_AGENT;
  return rowToConfig(row);
}

export function getAgentById(id: string): AgentConfig | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
  return row ? rowToConfig(row) : null;
}

export function getAllAgents(): AgentConfig[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agents ORDER BY created_at').all() as AgentRow[];
  return rows.map(rowToConfig);
}

export function getDefaultAgent(): AgentConfig {
  const name = process.env.DEFAULT_AGENT || 'otcclaw';
  const agent = getAgent(name);
  return agent;
}

export interface SaveAgentInput {
  name: string;
  displayName: string;
  description?: string;
  model?: string;
  provider?: string;
  toolsMode?: 'all' | 'standard' | 'allowlist' | 'blocklist';
  toolsList?: string[];
  blockTools?: string[];
  preset?: string;
  userToolsMode?: 'inherit' | 'all' | 'allowlist' | 'blocklist';
  userToolsList?: string[];
  maxHistory?: number;
}

export function saveAgent(input: SaveAgentInput): { success: true; action: 'created' | 'updated'; name: string; id?: string } | { success: false; error: string } {
  const db = getDb();
  const user = getCurrentUser();
  const existing = db.prepare('SELECT * FROM agents WHERE name = ?').get(input.name) as AgentRow | undefined;

  if (existing) {
    if (!isAgentAdmin(existing.id)) {
        return { success: false, error: `权限不足：需要 Agent (${input.name}) 的管理员权限` };
    }

    db.prepare(`UPDATE agents SET
      display_name = ?, description = ?, model = ?, provider = ?,
      tools_mode = ?, tools_list = ?, block_tools = ?, preset = ?, user_tools_mode = ?, user_tools_list = ?,
      max_history = ?, updated_at = datetime('now')
      WHERE name = ?`).run(
      input.displayName, input.description ?? null,
      input.model ?? null, input.provider ?? null,
      input.toolsMode ?? existing.tools_mode, input.toolsList ? JSON.stringify(input.toolsList) : existing.tools_list,
      input.blockTools ? JSON.stringify(input.blockTools) : (existing as any).block_tools ?? null,
      input.preset !== undefined ? (input.preset || null) : existing.preset,
      input.userToolsMode ?? existing.user_tools_mode,
      input.userToolsList ? JSON.stringify(input.userToolsList) : existing.user_tools_list,
      input.maxHistory ?? existing.max_history, input.name,
    );
    recordEvent('agent', existing.id, 'update', { name: input.name });
    return { success: true, action: 'updated', name: input.name };
  }

  if (!isSystemAdmin()) {
      return { success: false, error: '权限不足：创建新 Agent 需要系统管理员权限' };
  }

  const id = uuid();
  db.prepare(`INSERT INTO agents (id, name, display_name, description, model, provider, tools_mode, tools_list, block_tools, preset, user_tools_mode, user_tools_list, max_history, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.name, input.displayName, input.description ?? null,
    input.model ?? null, input.provider ?? null,
    input.toolsMode ?? 'standard', input.toolsList ? JSON.stringify(input.toolsList) : null,
    input.blockTools ? JSON.stringify(input.blockTools) : null,
    input.preset ?? null,
    input.userToolsMode ?? 'inherit', input.userToolsList ? JSON.stringify(input.userToolsList) : null,
    input.maxHistory ?? 80, user.id,
  );
  
  // 默认将创建者设为该 Agent 的 admin
  db.prepare('INSERT INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)').run(
      uuid(), id, user.id, 'admin'
  );

  recordEvent('agent', id, 'create', { name: input.name });
  return { success: true, action: 'created', name: input.name, id: id.slice(0, 8) };
}

export function deleteAgent(name: string): { success: true; name: string } | { success: false; error: string } {
  if (name === 'otcclaw') return { success: false, error: '不能删除默认 agent: otcclaw' };
  const db = getDb();
  const row = db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRow | undefined;
  if (!row) return { success: false, error: `未找到 agent: ${name}` };
  
  if (!isSystemAdmin() && !isAgentAdmin(row.id)) {
      return { success: false, error: `权限不足：需要 Agent (${name}) 的管理员权限或系统管理员权限` };
  }

  db.prepare('DELETE FROM agents WHERE id = ?').run(row.id);
  recordEvent('agent', row.id, 'delete', { name });
  return { success: true, name };
}

export interface AgentMember {
    username: string;
    id: string;
    role: string;
    created_at: string;
}

export function listAgentMembers(agentName: string): { success: true; data: AgentMember[] } | { success: false; error: string } {
    const db = getDb();
    const agent = db.prepare('SELECT id, name FROM agents WHERE name = ?').get(agentName) as { id: string, name: string } | undefined;
    if (!agent) return { success: false, error: `未找到 Agent: ${agentName}` };

    if (!isSystemAdmin() && !isAgentAdmin(agent.id)) {
        return { success: false, error: `权限不足：需要 Agent (${agentName}) 的管理员权限或系统管理员权限` };
    }

    try {
        const rows = db.prepare(`
            SELECT u.username, u.id, am.role, am.created_at
            FROM agent_members am
            JOIN users u ON am.user_id = u.id
            WHERE am.agent_id = ?
            ORDER BY am.role ASC, am.created_at DESC
        `).all(agent.id) as AgentMember[];
        return { success: true, data: rows };
    } catch (e: any) {
        return { success: false, error: `查询失败: ${e.message}` };
    }
}

export function manageAgentMember(action: 'add' | 'del', agentName: string, username: string, role: 'admin' | 'user' = 'admin'): { success: true } | { success: false; error: string } {
    const db = getDb();
    
    const agent = db.prepare('SELECT id, name FROM agents WHERE name = ?').get(agentName) as { id: string, name: string } | undefined;
    if (!agent) return { success: false, error: `未找到 Agent: ${agentName}` };
    
    if (!isSystemAdmin() && !isAgentAdmin(agent.id)) {
        return { success: false, error: `权限不足：需要 Agent (${agentName}) 的管理员权限或系统管理员权限` };
    }
    
    const targetUser = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username) as { id: string, username: string } | undefined;
    if (!targetUser) return { success: false, error: `未找到用户: ${username}` };
    
    try {
        if (action === 'add') {
            db.prepare('INSERT OR REPLACE INTO agent_members (id, agent_id, user_id, role) VALUES (?, ?, ?, ?)').run(
                uuid(), agent.id, targetUser.id, role
            );
        } else {
            db.prepare('DELETE FROM agent_members WHERE agent_id = ? AND user_id = ?').run(agent.id, targetUser.id);
        }
        return { success: true };
    } catch (e: any) {
        return { success: false, error: `操作失败: ${e.message}` };
    }
}

import Anthropic from '@anthropic-ai/sdk';

// --- Delivery & Tool context (shared with tool modules) ---

/** Channel-specific context injected by bot layers, used by reminder and health tools */
export interface DeliveryContext {
  channel: 'feishu' | 'telegram' | 'cli' | 'wework';
  targetId?: string;
  appId?: string;
  weworkClient?: any;
  weworkFrame?: any;
}

/** Context passed to every tool handler */
export interface ToolContext {
  deliveryContext?: DeliveryContext;
  /** All registered tools — needed by list_agents / get_agent to compute per-agent tool sets */
  globalTools?: Anthropic.Tool[];
  onProgress?: (event: { type: 'tool_progress'; message: string }) => void;
}

// --- Current agent session state ---

let _currentAgent: AgentConfig | undefined;

export function setCurrentAgent(agent: AgentConfig | undefined): void {
  _currentAgent = agent;
}

export function getCurrentAgent(): AgentConfig | undefined {
  return _currentAgent ?? getDefaultAgent();
}

/** Tools that are always available to all agents, regardless of tools_mode */
export const UNIVERSAL_TOOLS = new Set(['http_request']);
const CLI_ONLY_TOOLS = new Set([
  'list_agents',
  'get_agent',
  'manage_agent_member',
  'list_agent_members',
  'save_agent',
  'delete_agent',
  'switch_agent',
  'assign_agent',
  'unassign_agent',
  'list_agent_assignments',
]);

function applyChannelToolRestrictions(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (getExecutionChannel() === 'cli') return tools;
  return tools.filter(tool => !CLI_ONLY_TOOLS.has(tool.name));
}

/**
 * Filter global tools based on agent config and user role.
 *
 * Layer 1 — Agent effective set:
 *   'all'      → all global tools \ blockTools
 *   'standard' → (COMMON_SET ∪ toolsList) \ blockTools
 *   legacy 'allowlist'/'blocklist' → preset ∪ toolsList (kept for backward compat)
 *
 * Layer 2 — User filtering (non-admin only):
 *   'inherit'   → same as admin (no extra filtering)
 *   'allowlist'  → intersect with userToolsList
 *   'blocklist'  → subtract userToolsList
 *   'all'        → all global tools (bypass agent layer)
 *
 * Layer 3 — UNIVERSAL_TOOLS always added, CLI_ONLY_TOOLS filtered on non-CLI channels.
 */
export function getAgentTools(agent: AgentConfig, globalTools: Anthropic.Tool[], isAdmin = true): Anthropic.Tool[] {
  // Step 1: compute agent effective tool names
  let effectiveNames: Set<string>;

  if (agent.toolsMode === 'all') {
    effectiveNames = new Set(globalTools.map(t => t.name));
    for (const b of agent.blockTools) effectiveNames.delete(b);
  } else if (agent.toolsMode === 'standard') {
    const pluginToolNames = getPluginTools().map(t => t.name);
    const mcpToolNames = getMcpTools().map(t => t.name);
    effectiveNames = new Set([...COMMON_SET, ...agent.toolsList, ...pluginToolNames, ...mcpToolNames]);
    for (const b of agent.blockTools) effectiveNames.delete(b);
  } else {
    // Legacy allowlist/blocklist (backward compat for un-migrated agents)
    const presetTools = agent.preset ? (TOOL_PRESETS[agent.preset]?.tools ?? []) : [];
    const legacySet = new Set([...presetTools, ...agent.toolsList]);
    if (agent.toolsMode === 'allowlist') {
      effectiveNames = legacySet;
    } else {
      effectiveNames = new Set(globalTools.map(t => t.name));
      for (const b of legacySet) effectiveNames.delete(b);
    }
  }

  for (const [toolName, ownerAgentName] of Object.entries(AGENT_EXCLUSIVE_TOOLS)) {
    if (agent.name !== ownerAgentName) {
      effectiveNames.delete(toolName);
    }
  }

  // Step 2: user-level filtering (non-admin)
  if (!isAdmin) {
    const uMode = agent.userToolsMode;
    if (uMode === 'all') {
      effectiveNames = new Set(globalTools.map(t => t.name));
    } else if (uMode === 'allowlist') {
      const uSet = new Set(agent.userToolsList);
      effectiveNames = new Set([...effectiveNames].filter(n => uSet.has(n)));
    } else if (uMode === 'blocklist') {
      for (const b of agent.userToolsList) effectiveNames.delete(b);
    }
    // 'inherit': no extra filtering
  }

  // Step 3: universal tools always available + channel restrictions
  for (const u of UNIVERSAL_TOOLS) effectiveNames.add(u);
  const filtered = globalTools.filter(t => effectiveNames.has(t.name));
  return applyChannelToolRestrictions(filtered);
}

// --- Agent Assignment (channel/target → agent) ---

interface AssignmentRow {
  id: string;
  agent_id: string;
  channel: string;
  app_id: string | null;
  target_id: string | null;
  created_at: string;
}

export class AgentUnboundError extends Error {
  constructor(channel: string, appId?: string, targetId?: string) {
    const target = appId || targetId || 'unknown';
    super(`当前应用未绑定 Agent（channel=${channel}, id=${target}），请联系管理员执行 /agent assign 进行绑定。`);
    this.name = 'AgentUnboundError';
  }
}

/**
 * Resolve which agent to use for a given channel + app/target.
 * Returns null when no assignment exists — callers must handle the unbound case.
 */
export function resolveAgent(channel: string, appId?: string, targetId?: string): AgentConfig | null {
  const db = getDb();

  // Feishu: query by (channel='feishu', app_id=xxx, target_id IS NULL)
  if (channel === 'feishu' && appId) {
    const row = db.prepare(
      'SELECT a.* FROM agents a JOIN agent_assignments aa ON a.id = aa.agent_id WHERE aa.channel = ? AND aa.app_id = ? AND aa.target_id IS NULL'
    ).get(channel, appId) as AgentRow | undefined;
    if (row) return rowToConfig(row);
  }

  // Telegram: query by (channel='telegram', app_id IS NULL, target_id=xxx)
  if (channel === 'telegram' && targetId) {
    const row = db.prepare(
      'SELECT a.* FROM agents a JOIN agent_assignments aa ON a.id = aa.agent_id WHERE aa.channel = ? AND aa.app_id IS NULL AND aa.target_id = ?'
    ).get(channel, targetId) as AgentRow | undefined;
    if (row) return rowToConfig(row);
  }

  // WeWork: query by (channel='wework', app_id=botId OR app_id IS NULL)
  if (channel === 'wework') {
    if (appId) {
      const row = db.prepare(
        'SELECT a.* FROM agents a JOIN agent_assignments aa ON a.id = aa.agent_id WHERE aa.channel = ? AND aa.app_id = ?'
      ).get(channel, appId) as AgentRow | undefined;
      if (row) return rowToConfig(row);
    }
    // fallback: channel-level assignment without app_id
    const row = db.prepare(
      'SELECT a.* FROM agents a JOIN agent_assignments aa ON a.id = aa.agent_id WHERE aa.channel = ? AND aa.app_id IS NULL AND aa.target_id IS NULL'
    ).get(channel) as AgentRow | undefined;
    if (row) return rowToConfig(row);
  }

  return null;
}

export interface AssignmentInfo {
  id: string;
  agentName: string;
  agentDisplayName: string;
  channel: string;
  appId: string | null;
  appName: string | null;
  autoStart: number | null;
  targetId: string | null;
  createdAt: string;
}

export function listAssignments(): AssignmentInfo[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT aa.*, a.name as agent_name, a.display_name, ba.name as app_name, ba.auto_start
     FROM agent_assignments aa
     JOIN agents a ON a.id = aa.agent_id
     LEFT JOIN bot_apps ba ON ba.id = aa.app_id
     ORDER BY aa.channel, aa.app_id, aa.target_id`
  ).all() as (AssignmentRow & { agent_name: string; display_name: string; app_name: string | null; auto_start: number | null })[];
  return rows.map(r => ({
    id: r.id,
    agentName: r.agent_name,
    agentDisplayName: r.display_name,
    channel: r.channel,
    appId: r.app_id,
    appName: r.app_name,
    autoStart: r.auto_start,
    targetId: r.target_id,
    createdAt: r.created_at,
  }));
}

export interface BotAppRow {
  id: string;
  channel: string;
  name: string;
  secret: string;
  config: string;
  show_thinking: number;
  auto_start: number;
  created_at: string;
}

/** @deprecated Use BotAppRow */
export interface FeishuAppRow {
  app_id: string;
  app_name: string;
  app_secret: string;
  verification_token: string;
  encrypt_key: string;
  show_thinking: number;
  auto_start: number;
}

export function getBotApp(id: string): BotAppRow | null {
  return getDb().prepare('SELECT * FROM bot_apps WHERE id = ?').get(id) as BotAppRow | null;
}

export function getBotAppsByChannel(channel: string, onlyAutoStart = false): BotAppRow[] {
  const sql = onlyAutoStart
    ? 'SELECT * FROM bot_apps WHERE channel = ? AND auto_start = 1'
    : 'SELECT * FROM bot_apps WHERE channel = ?';
  return getDb().prepare(sql).all(channel) as BotAppRow[];
}

export function saveBotApp(app: { id: string; channel: string; name: string; secret: string; config?: string; show_thinking?: number; auto_start?: number }): void {
  getDb().prepare(`
    INSERT INTO bot_apps (id, channel, name, secret, config, show_thinking, auto_start)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      channel = excluded.channel,
      name = excluded.name,
      secret = excluded.secret,
      config = excluded.config,
      show_thinking = excluded.show_thinking,
      auto_start = excluded.auto_start
  `).run(app.id, app.channel, app.name, app.secret, app.config ?? '{}', app.show_thinking ?? 1, app.auto_start ?? 1);
}

export function getBotAppByAgentName(agentName: string, channel?: string): BotAppRow | null {
  const db = getDb();
  if (channel) {
    return db.prepare(`
      SELECT ba.* FROM bot_apps ba
      JOIN agent_assignments aa ON ba.id = aa.app_id
      JOIN agents a ON aa.agent_id = a.id
      WHERE a.name = ? AND aa.channel = ?
      LIMIT 1
    `).get(agentName, channel) as BotAppRow | null;
  }
  return db.prepare(`
    SELECT ba.* FROM bot_apps ba
    JOIN agent_assignments aa ON ba.id = aa.app_id
    JOIN agents a ON aa.agent_id = a.id
    WHERE a.name = ?
    LIMIT 1
  `).get(agentName) as BotAppRow | null;
}

/** @deprecated Use getBotApp */
export function getFeishuApp(appId: string): BotAppRow | null {
  return getBotApp(appId);
}

/** @deprecated Use getBotAppByAgentName */
export function getFeishuAppByAgentName(agentName: string): BotAppRow | null {
  return getBotAppByAgentName(agentName, 'feishu');
}

export function saveAssignment(
  agentName: string,
  channel: string,
  appId?: string,
  targetId?: string
): { success: true } | { success: false; error: string } {
  if (!isSystemAdmin()) {
    return { success: false, error: '权限不足：分配 Agent 需要系统管理员权限' };
  }
  const db = getDb();
  const agent = db.prepare('SELECT id FROM agents WHERE name = ?').get(agentName) as { id: string } | undefined;
  if (!agent) return { success: false, error: `未找到 Agent: ${agentName}` };

  // Upsert via DELETE + INSERT (SQLite UNIQUE constraint on channel+app_id+target_id)
  db.prepare('DELETE FROM agent_assignments WHERE channel = ? AND app_id IS ? AND target_id IS ?')
    .run(channel, appId ?? null, targetId ?? null);
  const id = uuid();
  db.prepare('INSERT INTO agent_assignments (id, agent_id, channel, app_id, target_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, agent.id, channel, appId ?? null, targetId ?? null);
  log.dim(`[Agent] Assignment saved: ${channel}/${appId || targetId || '(default)'} → ${agentName}`);
  return { success: true };
}

/** @deprecated Use saveBotApp */
export function saveFeishuApp(app: FeishuAppRow): void {
  saveBotApp({
    id: app.app_id,
    channel: 'feishu',
    name: app.app_name,
    secret: app.app_secret,
    config: JSON.stringify({
      verification_token: app.verification_token || '',
      encrypt_key: app.encrypt_key || '',
    }),
    show_thinking: app.show_thinking,
    auto_start: app.auto_start,
  });
}

export function deleteAssignment(
  channel: string,
  appId?: string,
  targetId?: string
): { success: true } | { success: false; error: string } {
  if (!isSystemAdmin()) {
    return { success: false, error: '权限不足：解除 Agent 分配需要系统管理员权限' };
  }
  const db = getDb();
  const result = db.prepare('DELETE FROM agent_assignments WHERE channel = ? AND app_id IS ? AND target_id IS ?')
    .run(channel, appId ?? null, targetId ?? null);
  if (result.changes === 0) {
    return { success: false, error: `未找到分配: ${channel}/${appId || targetId || '(default)'}` };
  }
  return { success: true };
}
