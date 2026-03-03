import { getDb } from '../db/connection.js';
import { getCurrentUser } from '../auth/rbac.js';
import { recordEvent } from '../models/event.js';
import { chat } from '../llm/agent.js';
import { log } from '../utils/logger.js';
import { renderTable } from '../utils/table.js';
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
  log.print('Skill 用法：');
  log.print('  skill list                          列出所有 skill');
  log.print('  skill save <name> "<prompt>"         保存 skill（支持 {param} 占位符）');
  log.print('  skill run <name> [param=value ...]   执行 skill');
  log.print('  skill del <name>                     删除 skill');
}

function listSkills(): void {
  const skills = getAllSkills();
  if (skills.length === 0) {
    log.print('暂无已保存的 skill');
    return;
  }

  const termWidth = process.stdout.columns || 120;

  // 所有列定义
  const allCols: { key: string; header: string; minWidth: number; extract: (s: Skill) => string }[] = [
    { key: 'name',    header: '名称',     minWidth: 18, extract: s => s.name },
    { key: 'params',  header: '参数',     minWidth: 14, extract: s => {
      const params = [...new Set([...s.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]))];
      return params.length > 0 ? params.join(', ') : '-';
    }},
    { key: 'prompt',  header: 'Prompt 摘要', minWidth: 30, extract: s => s.prompt },
    { key: 'author',  header: '创建者',   minWidth: 10, extract: s => s.created_by ?? '-' },
    { key: 'created', header: '创建时间', minWidth: 20, extract: s => s.created_at ?? '-' },
  ];

  // 从右侧裁剪列以适配终端宽度
  let visibleCols = [...allCols];
  const borderOf = (n: number) => n + 1;
  while (visibleCols.length > 2) {
    const totalMin = visibleCols.reduce((sum, col) => sum + col.minWidth, 0) + borderOf(visibleCols.length);
    if (totalMin <= termWidth) break;
    visibleCols.pop();
  }

  const head = visibleCols.map(col => col.header);
  const tableRows = skills.map(s => visibleCols.map(col => col.extract(s)));

  // 名称列动态扩展
  const nameIdx = visibleCols.findIndex(col => col.key === 'name');
  const colWidths = visibleCols.map((col, i) => {
    if (i === nameIdx) {
      const maxLen = Math.max(col.header.length, ...tableRows.map(row => row[i].length));
      return Math.min(Math.max(maxLen + 4, col.minWidth), 35);
    }
    return col.minWidth;
  });

  // 剩余空间分配给 prompt 摘要列
  const usedWidth = colWidths.reduce((s, w) => s + w, 0) + borderOf(visibleCols.length);
  const extraSpace = termWidth - usedWidth;
  if (extraSpace > 0) {
    const promptIdx = visibleCols.findIndex(col => col.key === 'prompt');
    if (promptIdx >= 0) {
      colWidths[promptIdx] += extraSpace;
    }
  }

  const cols = colWidths.map(width => ({ width }));

  renderTable(head, tableRows, cols);
  log.print(`共 ${skills.length} 个 skill`);
}

function saveSkill(args: string): void {
  // Parse: name "prompt" or name prompt
  const match = args.match(/^(\S+)\s+"([^"]+)"/s) || args.match(/^(\S+)\s+(.*)/s);
  if (!match) {
    log.print('用法: skill save <name> "<prompt>"');
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
    log.print(`Skill 已更新: ${name}`);
  } else {
    const id = uuid();
    db.prepare('INSERT INTO skills (id, name, prompt, created_by) VALUES (?, ?, ?, ?)').run(id, name, prompt, user.id);
    recordEvent('skill', id, 'create', { name, prompt });
    log.print(`Skill 已保存: ${name}`);
  }
}

function delSkill(args: string): void {
  const name = args.trim();
  if (!name) {
    log.print('用法: skill del <name>');
    return;
  }
  const skill = getSkillByName(name);
  if (!skill) {
    log.print(`未找到 skill: ${name}`);
    return;
  }
  const db = getDb();
  db.prepare('DELETE FROM skills WHERE id = ?').run(skill.id);
  recordEvent('skill', skill.id, 'delete', { name });
  log.print(`Skill 已删除: ${name}`);
}

async function runSkill(args: string): Promise<void> {
  const parts = args.match(/^(\S+)\s*(.*)/s);
  if (!parts) {
    log.print('用法: skill run <name> [param=value ...]');
    return;
  }
  const name = parts[1];
  const skill = getSkillByName(name);
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
  await chat(prompt);
}
