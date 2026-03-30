import { getDb } from '../db/connection.js';
import { v4 as uuid } from 'uuid';

export type Role = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  role: Role;
}

let currentUser: User | null = null;

export function setCurrentUser(user: User): void {
  currentUser = user;
}

export function getCurrentUser(): User {
  if (!currentUser) throw new Error('未登录');
  return currentUser;
}

export function isAdmin(): boolean {
  return getCurrentUser().role === 'admin';
}

export function isSystemAdmin(): boolean {
  return isAdmin();
}

export function isAgentAdmin(agentId: string): boolean {
  const user = getCurrentUser();
  if (user.role === 'admin') return true;

  const db = getDb();
  const row = db.prepare('SELECT role FROM agent_members WHERE agent_id = ? AND user_id = ?').get(agentId, user.id) as { role: string } | undefined;
  return row?.role === 'admin';
}

export function requireAdmin(): void {
  if (!isAdmin()) {
    throw new Error('权限不足：需要系统管理员权限');
  }
}

export function requireAgentAdmin(agentId: string): void {
  if (!isAgentAdmin(agentId)) {
    throw new Error('权限不足：需要该 Agent 的管理员权限');
  }
}

export function getAllUsers(): User[] {
  const db = getDb();
  return db.prepare('SELECT id, username, role FROM users').all() as User[];
}

export function getUser(id: string): User | undefined {
  const db = getDb();
  return db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as User | undefined;
}

export function createUser(username: string, role: Role = 'user'): User {
  const db = getDb();
  
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    throw new Error(`用户已存在: ${username}`);
  }

  const id = uuid();
  db.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)').run(id, username, role);
  return { id, username, role };
}

export function updateUser(id: string, updates: Partial<Pick<User, 'username' | 'role'>>): User {
  const db = getDb();
  const user = getUser(id);
  if (!user) {
    throw new Error(`用户不存在: ${id}`);
  }

  if (updates.username && updates.username !== user.username) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(updates.username);
    if (existing) {
      throw new Error(`用户名已被占用: ${updates.username}`);
    }
  }

  const newUsername = updates.username || user.username;
  const newRole = updates.role || user.role;

  db.prepare('UPDATE users SET username = ?, role = ? WHERE id = ?').run(newUsername, newRole, id);
  return { id, username: newUsername, role: newRole };
}

export function deleteUser(id: string): void {
  const db = getDb();
  const user = getUser(id);
  if (!user) {
    throw new Error(`用户不存在: ${id}`);
  }
  
  if (user.role === 'admin') {
    // 检查是否是最后一个 admin
    const admins = db.prepare("SELECT count(*) as count FROM users WHERE role = 'admin'").get() as { count: number };
    if (admins.count <= 1) {
      throw new Error('不能删除系统中最后一个管理员');
    }
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
