import { getDb } from '../db/connection.js';
import { getCurrentUser } from '../auth/rbac.js';
import { recordEvent } from '../models/event.js';
import { chat } from '../llm/agent.js';
import { log } from '../utils/logger.js';
import { v4 as uuid } from 'uuid';

export interface Skill {
  id: string;
  name: string;
  prompt: string;
  created_by: string;
  created_at: string;
}

export function getAllSkills(): Skill[] {
  const db = getDb();
  return db.prepare('SELECT * FROM skills ORDER BY created_at DESC').all() as Skill[];
}

export function getSkillByName(name: string): Skill | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as Skill) ?? null;
}

function parseKV(args: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of args.matchAll(/(\w+)=(\S+)/g)) {
    result[m[1]] = m[2];
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
    case 'save': return saveSkill(rest);
    case 'del': return delSkill(rest);
    case 'run': return runSkill(rest);
    default:
      // Treat as "skill run <name> ..."
      return runSkill(args);
  }
}

function showSkillHelp(): void {
  log.info('Skill 用法：');
  console.log('  skill list                          列出所有 skill');
  console.log('  skill save <name> "<prompt>"         保存 skill（支持 {param} 占位符）');
  console.log('  skill run <name> [param=value ...]   执行 skill');
  console.log('  skill del <name>                     删除 skill');
}

function listSkills(): void {
  const skills = getAllSkills();
  if (skills.length === 0) {
    log.dim('暂无已保存的 skill');
    return;
  }
  for (const s of skills) {
    const params = [...s.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    const paramStr = params.length > 0 ? ` [参数: ${params.join(', ')}]` : '';
    console.log(`  ${s.name.padEnd(20)} ${s.prompt.slice(0, 50)}${s.prompt.length > 50 ? '...' : ''}${paramStr}`);
  }
  log.dim(`共 ${skills.length} 个 skill`);
}

function saveSkill(args: string): void {
  // Parse: name "prompt" or name prompt
  const match = args.match(/^(\S+)\s+"([^"]+)"/s) || args.match(/^(\S+)\s+(.*)/s);
  if (!match) {
    log.warn('用法: skill save <name> "<prompt>"');
    return;
  }
  const name = match[1];
  const prompt = match[2];

  const db = getDb();
  const user = getCurrentUser();
  const existing = getSkillByName(name);

  if (existing) {
    db.prepare('UPDATE skills SET prompt = ? WHERE name = ?').run(prompt, name);
    recordEvent('skill', existing.id, 'update', { name, prompt });
    log.success(`Skill 已更新: ${name}`);
  } else {
    const id = uuid();
    db.prepare('INSERT INTO skills (id, name, prompt, created_by) VALUES (?, ?, ?, ?)').run(id, name, prompt, user.id);
    recordEvent('skill', id, 'create', { name, prompt });
    log.success(`Skill 已保存: ${name}`);
  }
}

function delSkill(args: string): void {
  const name = args.trim();
  if (!name) {
    log.warn('用法: skill del <name>');
    return;
  }
  const skill = getSkillByName(name);
  if (!skill) {
    log.error(`未找到 skill: ${name}`);
    return;
  }
  const db = getDb();
  db.prepare('DELETE FROM skills WHERE id = ?').run(skill.id);
  recordEvent('skill', skill.id, 'delete', { name });
  log.success(`Skill 已删除: ${name}`);
}

async function runSkill(args: string): Promise<void> {
  const parts = args.match(/^(\S+)\s*(.*)/s);
  if (!parts) {
    log.warn('用法: skill run <name> [param=value ...]');
    return;
  }
  const name = parts[1];
  const skill = getSkillByName(name);
  if (!skill) {
    log.error(`未找到 skill: ${name}`);
    return;
  }

  const params = parseKV(parts[2] || '');
  const prompt = resolvePrompt(skill.prompt, params);

  // Check for unresolved params
  const unresolved = [...prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  if (unresolved.length > 0) {
    log.warn(`缺少参数: ${unresolved.join(', ')}`);
    log.dim(`用法: skill run ${name} ${unresolved.map(p => `${p}=值`).join(' ')}`);
    return;
  }

  log.dim(`▶ 执行 skill [${name}]: ${prompt}`);
  await chat(prompt);
}
