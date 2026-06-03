/**
 * 飞书用户会话管理
 * 每个飞书 user 对应一个独立的对话上下文
 */
import Anthropic from '@anthropic-ai/sdk';
import { buildCanonicalUserId, getOrCreateUser, registerUserAliases } from '../auth/rbac.js';
import type { User } from '../auth/rbac.js';
import { resolveAgent, AgentUnboundError } from '../llm/agents/config.js';
import { summarizeAndUpdateWorkspace } from '../session/summarizer.js';
import { cleanupSandbox } from '../commands/sandbox.js';

export interface FeishuSession {
  feishuUserId: string;
  feishuUsername: string;
  user: User;                                   // 映射到系统用户
  history: Anthropic.MessageParam[];            // 对话历史
  lastActive: number;                            // 最后活跃时间戳
  agentName: string;                             // 当前使用的 Agent 名称
}

const sessions = new Map<string, FeishuSession>();

export function getSession(feishuUserId: string, feishuUsername: string): FeishuSession {
  let session = sessions.get(feishuUserId);
  if (!session) {
    const userId = buildCanonicalUserId('feishu', { open_id: feishuUserId });
    const legacyUserId = `feishu_${feishuUserId}`;
    const username = feishuUsername || legacyUserId;
    const user = getOrCreateUser(userId, username, 'user');
    registerUserAliases(userId, [legacyUserId], 'feishu legacy session identity');
    const agent = resolveAgent('feishu', feishuUserId);
    if (!agent) throw new AgentUnboundError('feishu', feishuUserId);
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
    summarizeAndUpdateWorkspace(session.agentName, session.user.id, session.history).catch(() => {});
    cleanupSandbox(session.agentName, session.user.id);
    session.history = [];
    const agent = resolveAgent('feishu', feishuUserId);
    if (agent) session.agentName = agent.name;
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
      summarizeAndUpdateWorkspace(session.agentName, session.user.id, session.history).catch(() => {});
      cleanupSandbox(session.agentName, session.user.id);
      sessions.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}
