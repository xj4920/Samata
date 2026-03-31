import { getDb } from '../db/connection.js';
import { getCurrentAgent } from '../llm/agent.js';
import { getCurrentUser, isSystemAdmin, isAgentAdmin } from '../auth/rbac.js';
import { recordEvent } from '../models/event.js';
import { chat } from '../llm/agent.js';
import { getAgentById } from '../llm/agents/config.js';
import { log } from '../utils/logger.js';
import { renderTable } from '../utils/table.js';
import { v4 as uuid } from 'uuid';

export interface Skill {
  id: string;
  name: string;
  prompt: string;
  description: string | null;
  agent_id: string | null;
  created_by: string;
  created_at: string;
}

export function getAllSkills(agentId?: string): Skill[] {
  const db = getDb();
  if (agentId) {
    return db.prepare('SELECT * FROM skills WHERE agent_id IS NULL OR agent_id = ? ORDER BY created_at DESC').all(agentId) as Skill[];
  }
  return db.prepare('SELECT * FROM skills ORDER BY created_at DESC').all() as Skill[];
}

export function getSkillByName(name: string, agentId?: string): Skill | null {
  const db = getDb();
  if (agentId) {
    // Prefer agent-specific skill, fall back to global
    const agentSkill = db.prepare('SELECT * FROM skills WHERE name = ? AND agent_id = ?').get(name, agentId) as Skill | undefined;
    if (agentSkill) return agentSkill;
  }
  return (db.prepare('SELECT * FROM skills WHERE name = ? AND agent_id IS NULL').get(name) as Skill) ?? null;
}

export function saveSkill(name: string, prompt: string, agentId?: string, description?: string): { success: true; action: 'created' | 'updated'; name: string; id?: string } | { success: false; error: string } {
  const db = getDb();
  const user = getCurrentUser();

  if (agentId) {
      if (!isSystemAdmin() && !isAgentAdmin(agentId)) {
          return { success: false, error: '权限不足：需要对应 Agent 的管理员权限或系统管理员权限' };
      }
  } else {
      if (!isSystemAdmin()) {
          return { success: false, error: '权限不足：保存全局 Skill 需要系统管理员权限' };
      }
  }

  const existing = getSkillByName(name, agentId);

  if (existing) {
    db.prepare('UPDATE skills SET prompt = ?, description = ?, agent_id = ? WHERE id = ?').run(prompt, description ?? existing.description ?? null, agentId ?? null, existing.id);
    recordEvent('skill', existing.id, 'update', { name, prompt, description, agent_id: agentId });
    return { success: true, action: 'updated', name };
  } else {
    const id = uuid();
    db.prepare('INSERT INTO skills (id, name, prompt, description, agent_id, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, prompt, description ?? null, agentId ?? null, user.id);
    recordEvent('skill', id, 'create', { name, prompt, description, agent_id: agentId });
    return { success: true, action: 'created', name, id: id.slice(0, 8) };
  }
}

export function deleteSkill(name: string): { success: true; name: string } | { success: false; error: string } {
  const skill = getSkillByName(name);
  if (!skill) return { success: false, error: `未找到 skill: ${name}` };
  
  if (skill.agent_id) {
      if (!isSystemAdmin() && !isAgentAdmin(skill.agent_id)) {
          return { success: false, error: '权限不足：需要对应 Agent 的管理员权限或系统管理员权限' };
      }
  } else {
      if (!isSystemAdmin()) {
          return { success: false, error: '权限不足：删除全局 Skill 需要系统管理员权限' };
      }
  }

  const db = getDb();
  db.prepare('DELETE FROM skills WHERE id = ?').run(skill.id);
  recordEvent('skill', skill.id, 'delete', { name });
  return { success: true, name };
}

function parseKV(args: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of args.matchAll(/(\w+)="([^"]+)"|(\w+)=(\S+)/g)) {
    const key = m[1] ?? m[3];
    const val = m[2] ?? m[4];
    result[key] = val;
  }
  return result;
}

function resolvePrompt(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? `{${key}}`);
}

export async function handleSkill(args: string): Promise<void> {
  const match = args.match(/^(\S+)\s*(.*)/s);
  if (!match) {
    showSkillHelp();
    return;
  }

  const sub = match[1].toLowerCase();
  const rest = match[2].trim();

  switch (sub) {
    case 'list': return listSkills();
    case 'save': return saveSkillCmd(rest);
    case 'del': return delSkillCmd(rest);
    case 'run': return runSkill(rest);
    default:
      // Treat as "skill run <name> ..."
      return runSkill(args);
  }
}

function showSkillHelp(): void {
  log.print('Skill 用法：');
  log.print('  skill list                          列出所有 skill');
  log.print('  skill save <name> "<prompt>"         保存 skill（支持 {param} 占位符）');
  log.print('  skill run <name> [param=value ...]   执行 skill');
  log.print('  skill del <name>                     删除 skill');
}

function listSkills(): void {
  const agentId = getCurrentAgent()?.id;
  const skills = getAllSkills(agentId);
  if (skills.length === 0) {
    log.print('暂无已保存的 skill');
    return;
  }

  const extractParams = (s: Skill) => {
    const params = [...new Set([...s.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]))];
    return params.length > 0 ? params.join(', ') : '-';
  };

  const head = ['名称', 'Agent', '参数', 'Prompt 摘要', '创建者', '创建时间'];
  const tableRows = skills.map(s => {
    const agentLabel = s.agent_id ? (getAgentById(s.agent_id)?.name ?? s.agent_id.slice(0, 8)) : '全局';
    return [
      s.name,
      agentLabel,
      extractParams(s),
      s.prompt.length > 60 ? s.prompt.slice(0, 57) + '...' : s.prompt,
      s.created_by ?? '-',
      s.created_at ?? '-',
    ];
  });

  renderTable(head, tableRows);
  log.print(`共 ${skills.length} 个 skill`);
}

function saveSkillCmd(args: string): void {
  const match = args.match(/^(\S+)\s+"([^"]+)"/s) || args.match(/^(\S+)\s+(.*)/s);
  if (!match) {
    log.print('用法: skill save <name> "<prompt>"');
    return;
  }
  const result = saveSkill(match[1], match[2]);
  if (!result.success) {
      log.print(result.error);
      return;
  }
  log.print(`Skill 已${result.action === 'updated' ? '更新' : '保存'}: ${result.name}`);
}

function delSkillCmd(args: string): void {
  const name = args.trim();
  if (!name) {
    log.print('用法: skill del <name>');
    return;
  }
  const result = deleteSkill(name);
  if (!result.success) {
    log.print(result.error);
    return;
  }
  log.print(`Skill 已删除: ${name}`);
}

async function runSkill(args: string): Promise<void> {
  const parts = args.match(/^(\S+)\s*(.*)/s);
  if (!parts) {
    log.print('用法: skill run <name> [param=value ...]');
    return;
  }
  const name = parts[1];
  const skill = getSkillByName(name, getCurrentAgent()?.id);
  if (!skill) {
    log.print(`未找到 skill: ${name}`);
    return;
  }

  const params = parseKV(parts[2] || '');
  const prompt = resolvePrompt(skill.prompt, params);

  // Check for unresolved params
  const unresolved = [...prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  if (unresolved.length > 0) {
    log.print(`缺少参数: ${unresolved.join(', ')}`);
    log.print(`用法: skill run ${name} ${unresolved.map(p => `${p}=值`).join(' ')}`);
    return;
  }

  log.print(`▶ 执行 skill [${name}]: ${prompt}`);
  recordEvent('skill', skill.id, 'run', { name, params });
  await chat(prompt);
}
