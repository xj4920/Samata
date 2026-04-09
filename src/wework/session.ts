/**
 * 企业微信会话管理
 *
 * mapKey 规则：
 * - 单聊: userId
 * - 群聊: "g:{chatid}:{userid}"
 *
 * 每个 bot 实例维护独立的 sessions Map（WeworkBotInstance.sessions）。
 */
import Anthropic from '@anthropic-ai/sdk';
import { getOrCreateUser } from '../auth/rbac.js';
import type { User } from '../auth/rbac.js';
import { resolveAgent, AgentUnboundError } from '../llm/agents/config.js';

export interface WeworkSession {
  weworkUserId: string;
  weworkUsername: string;
  user: User;
  history: Anthropic.MessageParam[];
  lastActive: number;
  agentName: string;
}

/**
 * @param botId  企微 bot ID（用于 agent 路由）
 * @param sessions  该 bot 实例的 sessions Map
 * @param mapKey 单聊时 = userId，群聊时 = "g:{chatid}:{userid}"
 * @param weworkUsername 显示用户名
 */
export function getSession(
  botId: string,
  sessions: Map<string, WeworkSession>,
  mapKey: string,
  weworkUsername: string,
): WeworkSession {
  let session = sessions.get(mapKey);
  if (!session) {
    const agent = resolveAgent('wework', botId);
    if (!agent) throw new AgentUnboundError('wework', botId);
    const bindingUserId = mapKey.startsWith('g:') ? mapKey.split(':')[2] : mapKey;
    const userId = `wework_${bindingUserId}`;
    const username = weworkUsername || `wework_${bindingUserId}`;
    getOrCreateUser(userId, username, 'user');
    session = {
      weworkUserId: bindingUserId,
      weworkUsername: username,
      user: { id: userId, username, role: 'user' },
      history: [],
      lastActive: Date.now(),
      agentName: agent.name,
    };
    sessions.set(mapKey, session);
  }
  session.lastActive = Date.now();
  session.weworkUsername = weworkUsername || session.weworkUsername;
  return session;
}

export function resetSession(botId: string, sessions: Map<string, WeworkSession>, mapKey: string): boolean {
  const session = sessions.get(mapKey);
  if (session) {
    session.history = [];
    const agent = resolveAgent('wework', botId);
    if (agent) session.agentName = agent.name;
    return true;
  }
  return false;
}

export function cleanupSessions(sessions: Map<string, WeworkSession>, maxAgeMs = 2 * 60 * 60 * 1000): number {
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
