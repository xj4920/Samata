import { getDb } from '../../db/connection.js';
import { getCurrentUser, isSystemAdmin, isAgentAdmin } from '../../auth/rbac.js';
import { recordEvent } from '../../models/event.js';
import { v4 as uuid } from 'uuid';
import { log } from '../../utils/logger.js';

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
  return getAgent('otcclaw');
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

/** Filter global tools based on agent's tools_mode and tools_list */
export function getAgentTools(agent: AgentConfig, globalTools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (agent.toolsMode === 'all') return globalTools;
  const set = new Set(agent.toolsList);
  if (agent.toolsMode === 'allowlist') {
    return globalTools.filter(t => set.has(t.name));
  }
  // blocklist
  return globalTools.filter(t => !set.has(t.name));
}

// --- Agent Assignment (channel/target → agent) ---

interface AssignmentRow {
  id: string;
  agent_id: string;
  channel: string;
  target_id: string | null;
  created_at: string;
}

/**
 * Resolve which agent to use for a given channel + target.
 * Priority: exact match (channel+target) > channel default > code fallback (otcclaw)
 */
export function resolveAgent(channel: string, targetId?: string): AgentConfig {
  const db = getDb();

  // 1. Exact match: channel + target_id
  if (targetId) {
    const row = db.prepare(
      'SELECT a.* FROM agents a JOIN agent_assignments aa ON a.id = aa.agent_id WHERE aa.channel = ? AND aa.target_id = ?'
    ).get(channel, targetId) as AgentRow | undefined;
    if (row) return rowToConfig(row);
  }

  // 2. Channel default: channel + target_id IS NULL
  const defaultRow = db.prepare(
    'SELECT a.* FROM agents a JOIN agent_assignments aa ON a.id = aa.agent_id WHERE aa.channel = ? AND aa.target_id IS NULL'
  ).get(channel) as AgentRow | undefined;
  if (defaultRow) return rowToConfig(defaultRow);

  // 3. Code-level fallback
  return getDefaultAgent();
}

export interface AssignmentInfo {
  id: string;
  agentName: string;
  agentDisplayName: string;
  channel: string;
  targetId: string | null;
  createdAt: string;
}

export function listAssignments(): AssignmentInfo[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT aa.*, a.name as agent_name, a.display_name FROM agent_assignments aa JOIN agents a ON a.id = aa.agent_id ORDER BY aa.channel, aa.target_id'
  ).all() as (AssignmentRow & { agent_name: string; display_name: string })[];
  return rows.map(r => ({
    id: r.id,
    agentName: r.agent_name,
    agentDisplayName: r.display_name,
    channel: r.channel,
    targetId: r.target_id,
    createdAt: r.created_at,
  }));
}

export function saveAssignment(agentName: string, channel: string, targetId?: string): { success: true } | { success: false; error: string } {
  const db = getDb();
  const agent = db.prepare('SELECT id FROM agents WHERE name = ?').get(agentName) as { id: string } | undefined;
  if (!agent) return { success: false, error: `未找到 Agent: ${agentName}` };

  // Upsert via DELETE + INSERT (SQLite UNIQUE constraint on channel+target_id)
  db.prepare('DELETE FROM agent_assignments WHERE channel = ? AND target_id IS ?').run(channel, targetId ?? null);
  const id = uuid();
  db.prepare('INSERT INTO agent_assignments (id, agent_id, channel, target_id) VALUES (?, ?, ?, ?)').run(id, agent.id, channel, targetId ?? null);
  log.dim(`[Agent] Assignment saved: ${channel}/${targetId ?? '(default)'} → ${agentName}`);
  return { success: true };
}

export function deleteAssignment(channel: string, targetId?: string): { success: true } | { success: false; error: string } {
  const db = getDb();
  const result = db.prepare('DELETE FROM agent_assignments WHERE channel = ? AND target_id IS ?').run(channel, targetId ?? null);
  if (result.changes === 0) return { success: false, error: `未找到分配: ${channel}/${targetId ?? '(default)'}` };
  return { success: true };
}
