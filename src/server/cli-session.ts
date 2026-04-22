import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { User } from '../auth/rbac.js';
import { getAllUsers } from '../auth/rbac.js';
import { getAgent, getDefaultAgent } from '../llm/agents/config.js';
import type { CliSessionInfo, CliUserInfo } from '../shared/cli-contract.js';
import { summarizeAndUpdateWorkspace } from '../session/summarizer.js';

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

export function createCliSession(username?: string, agentName?: string): CliSession {
  const users = getAllUsers();
  const user = username
    ? users.find(item => item.username === username)
    : users.find(item => item.username === 'admin') ?? users[0];

  if (!user) {
    throw new Error('未找到可登录用户');
  }

  const agent = agentName ? getAgent(agentName) : getDefaultAgent();
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
  summarizeAndUpdateWorkspace(session.agentName, session.user.id, session.history).catch(() => {});
  session.history = [];
  session.agentName = getDefaultAgent().name;
  session.updatedAt = Date.now();
  return session;
}

export function destroyCliSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    summarizeAndUpdateWorkspace(session.agentName, session.user.id, session.history).catch(() => {});
    sessions.delete(sessionId);
  }
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

// --- Prompt reply queue ---

const pendingPrompts = new Map<string, { resolve: (value: string) => void; reject: (err: Error) => void }>();

function promptKey(sessionId: string, promptId: string): string {
  return `${sessionId}:${promptId}`;
}

export function waitForPromptReply(sessionId: string, promptId: string, timeoutMs = 120_000): Promise<string> {
  const key = promptKey(sessionId, promptId);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPrompts.delete(key);
      reject(new Error('交互超时'));
    }, timeoutMs);
    pendingPrompts.set(key, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}

export function resolvePromptReply(sessionId: string, promptId: string, value: string): boolean {
  const key = promptKey(sessionId, promptId);
  const pending = pendingPrompts.get(key);
  if (!pending) return false;
  pendingPrompts.delete(key);
  pending.resolve(value);
  return true;
}
