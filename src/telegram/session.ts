/**
 * Telegram 用户会话管理
 * 每个 Telegram user 对应一个独立的对话上下文
 */
import Anthropic from '@anthropic-ai/sdk';
import type { User } from '../auth/rbac.js';
import { resolveAgent } from '../llm/agents/config.js';

export interface TelegramSession {
  telegramUserId: number;
  telegramUsername: string;
  user: User;                                   // 映射到系统用户
  history: Anthropic.MessageParam[];            // 对话历史
  lastActive: number;                            // 最后活跃时间戳
  agentName: string;                             // 当前使用的 Agent 名称
}

const sessions = new Map<number, TelegramSession>();

// Telegram userId → 系统用户映射（从 .env 配置）
let adminIds: Set<number> = new Set();

export function setAdminIds(ids: number[]): void {
  adminIds = new Set(ids);
}

export function isAdminTelegramUser(telegramUserId: number): boolean {
  return adminIds.has(telegramUserId);
}

export function getSession(telegramUserId: number, telegramUsername: string): TelegramSession {
  let session = sessions.get(telegramUserId);
  if (!session) {
    const role = adminIds.has(telegramUserId) ? 'admin' : 'user';
    const agent = resolveAgent('telegram', String(telegramUserId));
    session = {
      telegramUserId,
      telegramUsername,
      user: {
        id: role === 'admin' ? 'admin-001' : 'user-001',
        username: telegramUsername || `tg_${telegramUserId}`,
        role,
      },
      history: [],
      lastActive: Date.now(),
      agentName: agent.name,
    };
    sessions.set(telegramUserId, session);
  }
  session.lastActive = Date.now();
  session.telegramUsername = telegramUsername || session.telegramUsername;
  return session;
}

export function resetSession(telegramUserId: number): boolean {
  const session = sessions.get(telegramUserId);
  if (session) {
    session.history = [];
    const agent = resolveAgent('telegram', String(telegramUserId));
    session.agentName = agent.name;
    return true;
  }
  return false;
}

export function getAllSessions(): TelegramSession[] {
  return Array.from(sessions.values());
}

/**
 * 清理超时会话（默认 2 小时）
 */
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
