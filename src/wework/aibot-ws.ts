/**
 * 企微 WebSocket 客户端工厂
 *
 * 基于 @wecom/aibot-node-sdk 的 WSClient，每个 bot 实例独立连接。
 * WSS 连接直连企微服务器，不走 HTTP 代理（绕过 https_proxy 环境变量）。
 */
import https from 'node:https';
import { WSClient, WsConnectionManager, generateReqId } from '@wecom/aibot-node-sdk';
import type { WsFrame, TextMessage } from '@wecom/aibot-node-sdk';
import { log } from '../utils/logger.js';

const directAgent = new https.Agent();
const controlCharPatchMarker = Symbol.for('samata.wework.safe-json-control-char-parse');

export function escapeJsonStringControlChars(raw: string): string {
  let inString = false;
  let escaped = false;
  let changed = false;
  let out = '';

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const code = ch.charCodeAt(0);

    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }

    if (code >= 0 && code <= 0x1f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      changed = true;
      continue;
    }

    out += ch;
  }

  return changed ? out : raw;
}

export function parseWeworkWsJsonFrame(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const escaped = escapeJsonStringControlChars(raw);
    if (escaped === raw) throw err;
    return JSON.parse(escaped);
  }
}

export function installWeworkJsonControlCharPatch(): void {
  const proto = (WsConnectionManager as unknown as { prototype?: Record<PropertyKey, any> }).prototype;
  if (!proto || proto[controlCharPatchMarker]) return;

  proto.setupEventHandlers = function setupEventHandlersWithSafeJsonParse(this: any): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      this.logger.info('WebSocket connection established, sending auth...');
      this.missedPongCount = 0;
      this.lastCloseWasAuthFailure = false;
      this.sendAuth();
      this.onConnected?.();
    });

    this.ws.on('message', (data: { toString(): string }) => {
      try {
        const raw = data.toString();
        const frame = parseWeworkWsJsonFrame(raw);
        this.handleFrame(frame);
      } catch (error: any) {
        this.logger.error('Failed to parse WebSocket message:', error.message);
      }
    });

    this.ws.on('close', (code: number, reason: { toString(): string }) => {
      const reasonStr = reason.toString() || `code: ${code}`;
      this.logger.warn(`WebSocket connection closed: ${reasonStr}`);
      this.stopHeartbeat();
      this.clearPendingMessages(`WebSocket connection closed (${reasonStr})`);
      this.onDisconnected?.(reasonStr);
      this.ws = null;
      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error: Error) => {
      this.logger.error('WebSocket error:', error.message);
      this.onError?.(error);
    });

    this.ws.on('ping', () => {
      this.ws?.pong();
    });
  };

  proto[controlCharPatchMarker] = true;
}

export function createWsClient(botId: string, secret: string): WSClient {
  installWeworkJsonControlCharPatch();
  return new WSClient({
    botId,
    secret,
    maxReconnectAttempts: -1,
    maxAuthFailureAttempts: -1,
    wsOptions: { agent: directAgent },
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
