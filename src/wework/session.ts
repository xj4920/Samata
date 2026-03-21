/**
 * 企业微信会话管理
 * 每个企微用户对应一个独立的对话上下文
 */
import Anthropic from '@anthropic-ai/sdk';
import type { User } from '../auth/rbac.js';
import { resolveAgent } from '../llm/agents/config.js';

export interface WeworkSession {
  weworkUserId: string;
  weworkUsername: string;
  user: User;
  history: Anthropic.MessageParam[];
  lastActive: number;
  agentName: string;
}

const sessions = new Map<string, WeworkSession>();
let adminIds: Set<string> = new Set();

export function setAdminIds(ids: string[]): void {
  adminIds = new Set(ids);
}

export function isAdminWeworkUser(weworkUserId: string): boolean {
  return adminIds.has(weworkUserId);
}

export function getSession(weworkUserId: string, weworkUsername: string): WeworkSession {
  let session = sessions.get(weworkUserId);
  if (!session) {
    const role = adminIds.has(weworkUserId) ? 'admin' : 'user';
    const agent = resolveAgent('wework', weworkUserId);
    session = {
      weworkUserId,
      weworkUsername,
      user: {
        id: role === 'admin' ? 'admin-001' : 'user-001',
        username: weworkUsername || `wework_${weworkUserId}`,
        role,
      },
      history: [],
      lastActive: Date.now(),
      agentName: agent.name,
    };
    sessions.set(weworkUserId, session);
  }
  session.lastActive = Date.now();
  session.weworkUsername = weworkUsername || session.weworkUsername;
  return session;
}

export function resetSession(weworkUserId: string): boolean {
  const session = sessions.get(weworkUserId);
  if (session) {
    session.history = [];
    const agent = resolveAgent('wework', weworkUserId);
    session.agentName = agent.name;
    return true;
  }
  return false;
}

export function getAllSessions(): WeworkSession[] {
  return Array.from(sessions.values());
}

export function cleanupSessions(maxAgeMs = 2 * 60 * 60 * 1000): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of sessions) {
    if (now - session.lastActive > maxAgeMs) {
      sessions.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}
