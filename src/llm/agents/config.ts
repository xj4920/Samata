import { getDb } from '../../db/connection.js';
import { getCurrentUser, isSystemAdmin, isAgentAdmin } from '../../auth/rbac.js';
import { recordEvent } from '../../models/event.js';
import { v4 as uuid } from 'uuid';
import { log } from '../../utils/logger.js';

export const TOOL_PRESETS: Record<string, { description: string; tools: string[] }> = {
  common: {
    description: '通用助手：知识库、技能、记忆、Agent管理、文件读写',
    tools: [
      'search_knowledge', 'list_skills', 'get_skill', 'save_skill', 'delete_skill',
      'get_status_summary', 'list_agents', 'get_agent', 'save_agent', 'delete_agent', 'switch_agent',
      'save_memory', 'search_memory', 'delete_memory',
      'read_file', 'write_file', 'reload_app',
    ],
  },
  alter_ego: {
    description: '个人分身：包含 common 基础上额外支持知识库写入和企微 QA 提取',
    tools: [
      'search_knowledge', 'update_knowledge', 'extract_wework_qa',
      'list_skills', 'get_skill', 'save_skill', 'delete_skill',
      'get_status_summary', 'list_agents', 'get_agent', 'save_agent', 'delete_agent', 'switch_agent',
      'save_memory', 'search_memory', 'delete_memory',
      'read_file', 'write_file', 'reload_app',
    ],
  },
  readonly: {
    description: '只读助手：知识库查询、状态查看，无写入权限',
    tools: ['search_knowledge', 'get_status_summary', 'list_skills', 'get_skill', 'search_memory'],
  },
};

export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  provider?: string;
  toolsMode: 'all' | 'allowlist' | 'blocklist';
  toolsList: string[];
  maxHistory: number;
}

/** Code-level fallback when DB has no agents */
const DEFAULT_AGENT: AgentConfig = {
  id: 'default',
  name: 'otcclaw',
  displayName: '衍语助手',
  description: 'OTC 业务专家',
  toolsMode: 'all',
  toolsList: [],
  maxHistory: 80,
};

interface AgentRow {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  system_prompt: string | null;
  model: string | null;
  provider: string | null;
  tools_mode: string;
  tools_list: string | null;
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
    systemPrompt: row.system_prompt ?? undefined,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    toolsMode: row.tools_mode as AgentConfig['toolsMode'],
    toolsList: row.tools_list ? JSON.parse(row.tools_list) : [],
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
  systemPrompt?: string;
  model?: string;
  provider?: string;
  toolsMode?: 'all' | 'allowlist' | 'blocklist';
  toolsList?: string[];
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
      display_name = ?, description = ?, system_prompt = ?, model = ?, provider = ?,
      tools_mode = ?, tools_list = ?, max_history = ?, updated_at = datetime('now')
      WHERE name = ?`).run(
      input.displayName, input.description ?? null, input.systemPrompt ?? null,
      input.model ?? null, input.provider ?? null,
      input.toolsMode ?? existing.tools_mode, input.toolsList ? JSON.stringify(input.toolsList) : existing.tools_list,
      input.maxHistory ?? existing.max_history, input.name,
    );
    recordEvent('agent', existing.id, 'update', { name: input.name });
    return { success: true, action: 'updated', name: input.name };
  }

  if (!isSystemAdmin()) {
      return { success: false, error: '权限不足：创建新 Agent 需要系统管理员权限' };
  }

  const id = uuid();
  db.prepare(`INSERT INTO agents (id, name, display_name, description, system_prompt, model, provider, tools_mode, tools_list, max_history, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.name, input.displayName, input.description ?? null, input.systemPrompt ?? null,
    input.model ?? null, input.provider ?? null,
    input.toolsMode ?? 'allowlist', input.toolsList ? JSON.stringify(input.toolsList) : null,
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

/** Tools that are always available to all agents, regardless of tools_mode */
export const UNIVERSAL_TOOLS = new Set(['http_request']);

/** Filter global tools based on agent's tools_mode and tools_list */
export function getAgentTools(agent: AgentConfig, globalTools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (agent.toolsMode === 'all') return globalTools;
  const set = new Set(agent.toolsList);
  if (agent.toolsMode === 'allowlist') {
    return globalTools.filter(t => set.has(t.name) || UNIVERSAL_TOOLS.has(t.name));
  }
  // blocklist
  return globalTools.filter(t => !set.has(t.name) || UNIVERSAL_TOOLS.has(t.name));
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

/**
 * Resolve which agent to use for a given channel + app/target.
 * Priority:
 * - Feishu: app_id match > code fallback
 * - Telegram: target_id match > code fallback
 */
export function resolveAgent(channel: string, appId?: string, targetId?: string): AgentConfig {
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

  // Fallback to default
  return getDefaultAgent();
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
    `SELECT aa.*, a.name as agent_name, a.display_name, fa.app_name, fa.auto_start
     FROM agent_assignments aa
     JOIN agents a ON a.id = aa.agent_id
     LEFT JOIN feishu_apps fa ON fa.app_id = aa.app_id
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

export interface FeishuAppRow {
  app_id: string;
  app_name: string;
  app_secret: string;
  verification_token: string;
  encrypt_key: string;
  show_thinking: number;
  auto_start: number;
}

export function getFeishuAppByAgentName(agentName: string): FeishuAppRow | null {
  const db = getDb();
  return db.prepare(`
    SELECT fa.* FROM feishu_apps fa
    JOIN agent_assignments aa ON fa.app_id = aa.app_id
    JOIN agents a ON aa.agent_id = a.id
    WHERE a.name = ? AND aa.channel = 'feishu'
    LIMIT 1
  `).get(agentName) as FeishuAppRow | null;
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

export function getFeishuApp(appId: string): FeishuAppRow | null {
  return getDb().prepare('SELECT * FROM feishu_apps WHERE app_id = ?').get(appId) as FeishuAppRow | null;
}

export function saveFeishuApp(app: FeishuAppRow): void {
  getDb().prepare(`
    INSERT INTO feishu_apps (app_id, app_name, app_secret, verification_token, encrypt_key, show_thinking, auto_start)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(app_id) DO UPDATE SET
      app_name = excluded.app_name,
      app_secret = excluded.app_secret,
      verification_token = excluded.verification_token,
      encrypt_key = excluded.encrypt_key,
      show_thinking = excluded.show_thinking,
      auto_start = excluded.auto_start
  `).run(app.app_id, app.app_name, app.app_secret, app.verification_token, app.encrypt_key, app.show_thinking, app.auto_start);
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
