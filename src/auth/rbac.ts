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

export function requireAdmin(): void {
  if (!isAdmin()) {
    throw new Error('权限不足：需要管理员权限');
  }
}

export function getAllUsers(): User[] {
  const db = getDb();
  return db.prepare('SELECT id, username, role FROM users').all() as User[];
}
