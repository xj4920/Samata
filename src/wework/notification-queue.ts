import { log } from '../utils/logger.js';

const DEFAULT_MIN_INTERVAL_MS = 2000;
const MIN_ALLOWED_INTERVAL_MS = 800;
const RATE_LIMIT_RETRY_DELAYS_MS = [5000, 15000, 30000];
const DEFAULT_QUEUE_KEY = '__default__';

interface WeworkNotificationClient {
  sendMessage(chatid: string, body: any): Promise<unknown>;
}

type WeworkClientResolver = (botIdOrName?: string) => WeworkNotificationClient | null;

interface QueueState {
  tail: Promise<void>;
  lastAttemptAt: number;
}

interface WeworkErrorDetails {
  botIdOrName?: string;
  targetId: string;
  reqId?: string;
  errcode?: number | string;
  errmsg?: string;
  hint?: string;
  attempt?: number;
  cause?: unknown;
}

export class WeworkNotificationError extends Error {
  botIdOrName?: string;
  targetId: string;
  reqId?: string;
  errcode?: number | string;
  errmsg?: string;
  hint?: string;
  attempt?: number;

  constructor(message: string, details: WeworkErrorDetails) {
    super(message);
    this.name = 'WeworkNotificationError';
    this.botIdOrName = details.botIdOrName;
    this.targetId = details.targetId;
    this.reqId = details.reqId;
    this.errcode = details.errcode;
    this.errmsg = details.errmsg;
    this.hint = details.hint;
    this.attempt = details.attempt;
    if (details.cause !== undefined) {
      (this as any).cause = details.cause;
    }
  }
}

const queues = new Map<string, QueueState>();
let resolveWeworkClient: WeworkClientResolver = () => null;

export function setWeworkNotificationClientResolver(resolver: WeworkClientResolver): void {
  resolveWeworkClient = resolver;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getQueueKey(botIdOrName?: string): string {
  const key = botIdOrName?.trim();
  return key || DEFAULT_QUEUE_KEY;
}

function getMinIntervalMs(): number {
  const configured = Number(process.env.WEWORK_SEND_MIN_INTERVAL_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MIN_INTERVAL_MS;
  return Math.max(Math.floor(configured), MIN_ALLOWED_INTERVAL_MS);
}

function getQueueState(key: string): QueueState {
  let state = queues.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), lastAttemptAt: 0 };
    queues.set(key, state);
  }
  return state;
}

function pickString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function normalizeWeworkError(err: any): Omit<WeworkErrorDetails, 'botIdOrName' | 'targetId' | 'cause'> {
  return {
    reqId: pickString(err?.reqId ?? err?.req_id ?? err?.requestId ?? err?.request_id),
    errcode: err?.errcode ?? err?.errorCode ?? err?.code,
    errmsg: pickString(err?.errmsg ?? err?.message ?? err?.errorMessage),
    hint: pickString(err?.hint),
  };
}

function isFrequencyLimitError(err: any): boolean {
  const normalized = normalizeWeworkError(err);
  return String(normalized.errcode ?? '') === '846607'
    || /frequency limit exceeded/i.test(normalized.errmsg ?? '');
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function buildErrorMessage(prefix: string, details: WeworkErrorDetails): string {
  const parts = [
    `bot=${details.botIdOrName || DEFAULT_QUEUE_KEY}`,
    `target=${details.targetId}`,
    details.reqId ? `reqId=${details.reqId}` : '',
    details.errcode !== undefined ? `errcode=${details.errcode}` : '',
    details.errmsg ? `errmsg=${details.errmsg}` : '',
    details.hint ? `hint=${details.hint}` : '',
    details.attempt !== undefined ? `attempt=${details.attempt}` : '',
  ].filter(Boolean);
  return `${prefix}: ${parts.join(', ')}`;
}

async function waitForMinInterval(state: QueueState): Promise<void> {
  const minIntervalMs = getMinIntervalMs();
  const elapsed = Date.now() - state.lastAttemptAt;
  if (state.lastAttemptAt > 0 && elapsed < minIntervalMs) {
    await sleep(minIntervalMs - elapsed);
  }
  state.lastAttemptAt = Date.now();
}

async function sendOnce(botIdOrName: string | undefined, targetId: string, message: string): Promise<void> {
  let ws = resolveWeworkClient(botIdOrName);
  if (!ws) {
    try {
      const bot = await import('./bot.js');
      ws = bot.getConnectedWsClient(botIdOrName);
    } catch {
      ws = null;
    }
  }
  if (!ws) {
    throw new WeworkNotificationError(
      botIdOrName ? `无可用企微连接: ${botIdOrName}` : '无可用企微连接',
      { botIdOrName, targetId },
    );
  }

  await ws.sendMessage(targetId, {
    msgtype: 'markdown',
    markdown: { content: message },
  });
}

async function sendWithRetries(state: QueueState, botIdOrName: string | undefined, targetId: string, message: string): Promise<void> {
  const maxAttempts = RATE_LIMIT_RETRY_DELAYS_MS.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await waitForMinInterval(state);

    try {
      await sendOnce(botIdOrName, targetId, message);
      return;
    } catch (err: any) {
      const normalized = normalizeWeworkError(err);
      const details = { ...normalized, botIdOrName, targetId, attempt, cause: err };
      const retryDelay = RATE_LIMIT_RETRY_DELAYS_MS[attempt - 1];

      if (retryDelay !== undefined && isFrequencyLimitError(err)) {
        log.warn(buildErrorMessage(`企微主动推送触发频率限制，${retryDelay}ms 后重试`, details));
        await sleep(retryDelay);
        continue;
      }

      const messageText = buildErrorMessage('企微主动推送失败', {
        ...details,
        errmsg: details.errmsg ?? describeError(err),
      });
      log.error(messageText);
      throw new WeworkNotificationError(messageText, {
        ...details,
        errmsg: details.errmsg ?? describeError(err),
      });
    }
  }
}

export async function sendWeworkNotification(targetId: string, message: string, botIdOrName?: string): Promise<void> {
  const key = getQueueKey(botIdOrName);
  const state = getQueueState(key);
  const previous = state.tail.catch(() => undefined);
  const task = previous.then(() => sendWithRetries(state, botIdOrName, targetId, message));
  state.tail = task.catch(() => undefined);
  return task;
}

export function __resetWeworkNotificationQueuesForTests(): void {
  queues.clear();
  resolveWeworkClient = () => null;
}
