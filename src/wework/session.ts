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
import { resolveExternalUserWithStatus } from '../auth/rbac.js';
import type { ExternalUserResolution, User } from '../auth/rbac.js';
import { resolveAgent, AgentUnboundError } from '../llm/agents/config.js';
import { summarizeAndUpdateWorkspace } from '../session/summarizer.js';
import { cleanupSandbox } from '../commands/sandbox.js';

export interface WeworkSession {
  weworkUserId: string;
  weworkUsername: string;
  user: User;
  history: Anthropic.MessageParam[];
  lastActive: number;
  agentName: string;
}

export interface WeworkMessageIdentityContext {
  rawFrom?: unknown;
  rawUserId: string;
  msgid?: string;
  chattype?: string;
  chatid?: string;
  aibotid?: string;
  create_time?: number;
  botId: string;
  botName: string;
}

export interface WeworkUserAutoCreatedEvent {
  resolution: ExternalUserResolution;
  context: WeworkMessageIdentityContext;
  agentName: string;
}

export interface WeworkSessionOptions {
  identityContext?: WeworkMessageIdentityContext;
  onUserAutoCreated?: (event: WeworkUserAutoCreatedEvent) => void;
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
  options: WeworkSessionOptions = {},
): WeworkSession {
  const bindingUserId = mapKey.startsWith('g:') ? mapKey.split(':')[2] : mapKey;
  let session = sessions.get(mapKey);
  let resolvedUser: User;
  if (!session) {
    const agent = resolveAgent('wework', botId);
    if (!agent) throw new AgentUnboundError('wework', botId);
    const resolution = resolveExternalUserWithStatus('wework', { userid: bindingUserId }, weworkUsername || `wework_${bindingUserId.slice(-6)}`);
    resolvedUser = resolution.user;
    session = {
      weworkUserId: bindingUserId,
      weworkUsername: resolvedUser.display_name || resolvedUser.username,
      user: resolvedUser,
      history: [],
      lastActive: Date.now(),
      agentName: agent.name,
    };
    sessions.set(mapKey, session);
    if (resolution.created && options.identityContext) {
      options.onUserAutoCreated?.({ resolution, context: options.identityContext, agentName: agent.name });
    }
  } else {
    const resolution = resolveExternalUserWithStatus('wework', { userid: bindingUserId }, session.user.username || weworkUsername || `wework_${bindingUserId.slice(-6)}`);
    resolvedUser = resolution.user;
    session.weworkUserId = bindingUserId;
    session.user = resolvedUser;
    if (resolution.created && options.identityContext) {
      options.onUserAutoCreated?.({ resolution, context: options.identityContext, agentName: session.agentName });
    }
  }
  session.lastActive = Date.now();
  session.weworkUsername = resolvedUser.display_name || resolvedUser.username || weworkUsername || session.weworkUsername;
  return session;
}

export function resetSession(botId: string, sessions: Map<string, WeworkSession>, mapKey: string): boolean {
  const session = sessions.get(mapKey);
  if (session) {
    summarizeAndUpdateWorkspace(session.agentName, session.user.id, session.history).catch(() => {});
    cleanupSandbox(session.agentName, session.user.id);
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
      summarizeAndUpdateWorkspace(session.agentName, session.user.id, session.history).catch(() => {});
      cleanupSandbox(session.agentName, session.user.id);
      sessions.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}
