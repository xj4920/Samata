import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { User } from '../auth/rbac.js';
import { getAllUsers } from '../auth/rbac.js';
import { getAgent, getDefaultAgent } from '../llm/agents/config.js';
import type { CliSessionInfo, CliUserInfo } from '../shared/cli-contract.js';

export interface CliSession {
  id: string;
  user: User;
  agentName: string;
  history: Anthropic.MessageParam[];
  updatedAt: number;
}

const sessions = new Map<string, CliSession>();

function toUserInfo(user: User): CliUserInfo {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}

export function listCliUsers(): CliUserInfo[] {
  return getAllUsers().map(toUserInfo);
}

export function createCliSession(username?: string): CliSession {
  const users = getAllUsers();
  const user = username
    ? users.find(item => item.username === username)
    : users.find(item => item.username === 'admin') ?? users[0];

  if (!user) {
    throw new Error('未找到可登录用户');
  }

  const agent = getDefaultAgent();
  const session: CliSession = {
    id: randomUUID(),
    user,
    agentName: agent.name,
    history: [],
    updatedAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getCliSession(sessionId: string): CliSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('CLI 会话不存在或已过期');
  }
  session.updatedAt = Date.now();
  return session;
}

export function updateCliSession(sessionId: string, updates: Partial<Pick<CliSession, 'agentName' | 'history'>>): CliSession {
  const session = getCliSession(sessionId);
  if (updates.agentName !== undefined) session.agentName = updates.agentName;
  if (updates.history !== undefined) session.history = updates.history;
  session.updatedAt = Date.now();
  return session;
}

export function resetCliSession(sessionId: string): CliSession {
  const session = getCliSession(sessionId);
  session.history = [];
  session.agentName = getDefaultAgent().name;
  session.updatedAt = Date.now();
  return session;
}

export function destroyCliSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function toCliSessionInfo(session: CliSession): CliSessionInfo {
  const agent = getAgent(session.agentName);
  return {
    sessionId: session.id,
    user: toUserInfo(session.user),
    agentName: agent.name,
    agentDisplayName: agent.displayName,
  };
}
