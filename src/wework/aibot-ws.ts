/**
 * 企微 WebSocket 客户端工厂
 *
 * 基于 @wecom/aibot-node-sdk 的 WSClient，每个 bot 实例独立连接。
 */
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type { WsFrame, TextMessage } from '@wecom/aibot-node-sdk';
import { log } from '../utils/logger.js';

export function createWsClient(botId: string, secret: string): WSClient {
  return new WSClient({
    botId,
    secret,
    maxReconnectAttempts: -1,
    logger: {
      debug: (...args: any[]) => log.dim(`[企微WS:${botId.slice(-6)}] ${args.join(' ')}`),
      info:  (...args: any[]) => log.info(`[企微WS:${botId.slice(-6)}] ${args.join(' ')}`),
      warn:  (...args: any[]) => log.warn(`[企微WS:${botId.slice(-6)}] ${args.join(' ')}`),
      error: (...args: any[]) => log.error(`[企微WS:${botId.slice(-6)}] ${args.join(' ')}`),
    },
  });
}

export { generateReqId };
export type { WsFrame, TextMessage };
