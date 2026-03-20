/**
 * 飞书用户会话管理
 * 每个飞书 user 对应一个独立的对话上下文
 */
import Anthropic from '@anthropic-ai/sdk';
import type { User } from '../auth/rbac.js';
import { resolveAgent } from '../llm/agents/config.js';
import { getDb } from '../db/connection.js';

export interface FeishuSession {
  feishuUserId: string;
  feishuUsername: string;
  user: User;                                   // 映射到系统用户
  history: Anthropic.MessageParam[];            // 对话历史
  lastActive: number;                            // 最后活跃时间戳
  agentName: string;                             // 当前使用的 Agent 名称
}

const sessions = new Map<string, FeishuSession>();

// 飞书 userId → 系统用户映射（从环境变量配置）
let adminIds: Set<string> = new Set();

export function setAdminIds(ids: string[]): void {
  adminIds = new Set(ids);
}

export function isAdminFeishuUser(feishuUserId: string): boolean {
  return adminIds.has(feishuUserId);
}

export function getSession(feishuUserId: string, feishuUsername: string): FeishuSession {
  let session = sessions.get(feishuUserId);
  if (!session) {
    const isAdmin = adminIds.has(feishuUserId);
    let user: User;
    if (isAdmin) {
      user = { id: 'admin-001', username: feishuUsername || `feishu_${feishuUserId}`, role: 'admin' };
    } else {
      const db = getDb();
      const userId = `feishu_${feishuUserId}`;
      const username = feishuUsername || userId;
      db.prepare('INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, ?)').run(userId, username, 'user');
      user = { id: userId, username, role: 'user' };
    }
    const agent = resolveAgent('feishu', feishuUserId);
    session = {
      feishuUserId,
      feishuUsername,
      user,
      history: [],
      lastActive: Date.now(),
      agentName: agent.name,
    };
    sessions.set(feishuUserId, session);
  }
  session.lastActive = Date.now();
  session.feishuUsername = feishuUsername || session.feishuUsername;
  return session;
}

export function resetSession(feishuUserId: string): boolean {
  const session = sessions.get(feishuUserId);
  if (session) {
    session.history = [];
    const agent = resolveAgent('feishu', feishuUserId);
    session.agentName = agent.name;
    return true;
  }
  return false;
}

export function getAllSessions(): FeishuSession[] {
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
