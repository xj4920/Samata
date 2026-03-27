import { getDb } from '../db/connection.js';
import { v4 as uuid } from 'uuid';
import type { CreateTodoInput, ListTodosInput, UpdateTodoInput } from '../llm/tool-types.js';

export interface Todo {
  id: string;
  agent_id: string | null;
  user_id: string | null;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'done';
  priority: 'low' | 'normal' | 'high';
  due_date: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export function createTodo(
  input: CreateTodoInput,
  agentId?: string,
  userId?: string,
): { success: true; id: string; todo: Todo } {
  const db = getDb();
  const id = uuid();
  db.prepare(
    `INSERT INTO todos (id, agent_id, user_id, title, description, priority, due_date, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    agentId ?? null,
    userId ?? null,
    input.title,
    input.description ?? null,
    input.priority ?? 'normal',
    input.due_date ?? null,
    input.tags?.length ? JSON.stringify(input.tags) : null,
  );
  const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as any;
  const todo: Todo = { ...row, tags: parseTags(row.tags) };
  return { success: true, id: id.slice(0, 8), todo };
}

export function listTodos(
  input: ListTodosInput,
  agentId?: string,
  userId?: string,
): Todo[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
  if (userId) { conditions.push('user_id = ?'); params.push(userId); }

  const statusFilter = input.status ?? 'active';
  if (statusFilter === 'all') {
    // no filter
  } else if (statusFilter === 'done') {
    conditions.push("status = 'done'");
  } else {
    // default: show non-done items
    conditions.push("status != 'done'");
  }

  if (input.priority) { conditions.push('priority = ?'); params.push(input.priority); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM todos ${where} ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       due_date ASC NULLS LAST,
       created_at ASC`
  ).all(...params) as any[];
  return rows.map(r => ({ ...r, tags: parseTags(r.tags) })) as Todo[];
}

export function updateTodo(
  input: UpdateTodoInput,
  agentId?: string,
  userId?: string,
): { success: boolean; error?: string; todo?: Todo } {
  const db = getDb();
  const conditions: string[] = ['id LIKE ?'];
  const params: any[] = [input.id + '%'];
  if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
  if (userId) { conditions.push('user_id = ?'); params.push(userId); }

  const row = db.prepare(`SELECT id FROM todos WHERE ${conditions.join(' AND ')}`).get(...params) as { id: string } | undefined;
  if (!row) return { success: false, error: `未找到 todo: ${input.id}` };

  const sets: string[] = ["updated_at = datetime('now')"];
  const setParams: any[] = [];
  if (input.title !== undefined) { sets.push('title = ?'); setParams.push(input.title); }
  if (input.description !== undefined) { sets.push('description = ?'); setParams.push(input.description); }
  if (input.status !== undefined) { sets.push('status = ?'); setParams.push(input.status); }
  if (input.priority !== undefined) { sets.push('priority = ?'); setParams.push(input.priority); }
  if (input.due_date !== undefined) { sets.push('due_date = ?'); setParams.push(input.due_date || null); }
  if (input.tags !== undefined) { sets.push('tags = ?'); setParams.push(input.tags.length ? JSON.stringify(input.tags) : null); }

  db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...setParams, row.id);
  const updated = db.prepare('SELECT * FROM todos WHERE id = ?').get(row.id) as any;
  const todo: Todo = { ...updated, tags: parseTags(updated.tags) };
  return { success: true, todo };
}

export function deleteTodo(
  id: string,
  agentId?: string,
  userId?: string,
): { success: boolean; error?: string } {
  const db = getDb();
  const conditions: string[] = ['id LIKE ?'];
  const params: any[] = [id + '%'];
  if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
  if (userId) { conditions.push('user_id = ?'); params.push(userId); }

  const row = db.prepare(`SELECT id FROM todos WHERE ${conditions.join(' AND ')}`).get(...params) as { id: string } | undefined;
  if (!row) return { success: false, error: `未找到 todo: ${id}` };

  db.prepare('DELETE FROM todos WHERE id = ?').run(row.id);
  return { success: true };
}
