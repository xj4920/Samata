import { getDb } from '../db/connection.js';

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
