import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { User } from '../auth/rbac.js';
import {
  isSupersededTurnError,
  runAgenticChat,
  SupersededTurnError,
  type ImageInput,
  type RunAgenticChatOptions,
} from '../llm/agent.js';

const MAX_SUPPLEMENTS = 20;
const MAX_SUPPLEMENT_CHARS = 8000;

export interface SupplementMessage {
  text: string;
  images?: ImageInput[];
  receivedAt: number;
  sourceMessageId?: string;
}

interface ActiveAgentTurn {
  key: string;
  ownerToken: string;
  baseHistory: Anthropic.MessageParam[];
  originalInput: string;
  originalImages?: ImageInput[];
  supplements: SupplementMessage[];
  controller: AbortController;
  startedAt: number;
  restartCount: number;
}

export interface RunCoordinatedAgentTurnInput {
  key: string;
  history: Anthropic.MessageParam[];
  input: string;
  user: User;
  options?: RunAgenticChatOptions;
  sourceMessageId?: string;
  now?: () => number;
  runner?: typeof runAgenticChat;
}

export type CoordinatedAgentTurnResult =
  | { status: 'completed'; reply: string; restartCount: number }
  | { status: 'superseded'; reply: ''; restartCount: number };

const activeTurns = new Map<string, ActiveAgentTurn>();

export function makeAgentTurnKey(channel: string, appId: string | undefined | null, sessionKey: string): string {
  return [channel, appId || '-', sessionKey].map(part => encodeURIComponent(part)).join(':');
}

function cloneHistory(history: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return typeof structuredClone === 'function'
    ? structuredClone(history)
    : JSON.parse(JSON.stringify(history));
}

function replaceHistory(target: Anthropic.MessageParam[], source: Anthropic.MessageParam[]): void {
  target.length = 0;
  target.push(...cloneHistory(source));
}

function trimSupplements(supplements: SupplementMessage[]): SupplementMessage[] {
  return supplements.slice(-MAX_SUPPLEMENTS);
}

function supplementTextLength(item: SupplementMessage): number {
  return item.text.trim().length;
}

function selectSupplementsForPrompt(supplements: SupplementMessage[]): { selected: SupplementMessage[]; omitted: number } {
  const recent = trimSupplements(supplements);
  const selected: SupplementMessage[] = [];
  let remaining = MAX_SUPPLEMENT_CHARS;

  for (let i = recent.length - 1; i >= 0; i--) {
    const item = recent[i];
    const len = supplementTextLength(item);
    if (len > remaining && selected.length > 0) break;
    selected.unshift(item);
    remaining -= Math.min(len, remaining);
  }

  return {
    selected,
    omitted: supplements.length - selected.length,
  };
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

export function buildInputWithSupplements(originalInput: string, supplements: SupplementMessage[]): string {
  const { selected, omitted } = selectSupplementsForPrompt(supplements);
  if (selected.length === 0) return originalInput;

  const lines = [
    originalInput,
    '',
    '[用户补充信息]',
    '以下是用户在你处理过程中追加的信息，请合并理解；若与前文冲突，以较新的补充为准。',
    '',
  ];

  if (omitted > 0) {
    lines.push(`（较早的 ${omitted} 条补充因数量或长度限制未完整展开。）`, '');
  }

  selected.forEach((item, index) => {
    const text = item.text.trim() || (item.images?.length ? `[补充图片 ${item.images.length} 张]` : '（空补充）');
    const imageHint = item.images?.length ? `，包含图片 ${item.images.length} 张` : '';
    lines.push(`${index + 1}. ${formatTimestamp(item.receivedAt)}${imageHint}`);
    lines.push(text);
    lines.push('');
  });

  return lines.join('\n').trim();
}

function mergeImages(active: ActiveAgentTurn): ImageInput[] | undefined {
  const images: ImageInput[] = [];
  if (active.originalImages?.length) images.push(...active.originalImages);
  for (const supplement of active.supplements) {
    if (supplement.images?.length) images.push(...supplement.images);
  }
  return images.length > 0 ? images : undefined;
}

function createTurn(input: RunCoordinatedAgentTurnInput, now: number): ActiveAgentTurn {
  const turn: ActiveAgentTurn = {
    key: input.key,
    ownerToken: randomUUID(),
    baseHistory: cloneHistory(input.history),
    originalInput: input.input,
    originalImages: input.options?.images ? [...input.options.images] : undefined,
    supplements: [],
    controller: new AbortController(),
    startedAt: now,
    restartCount: 0,
  };
  activeTurns.set(input.key, turn);
  return turn;
}

function restartTurn(active: ActiveAgentTurn, input: RunCoordinatedAgentTurnInput, now: number): ActiveAgentTurn {
  active.supplements.push({
    text: input.input,
    images: input.options?.images ? [...input.options.images] : undefined,
    receivedAt: now,
    sourceMessageId: input.sourceMessageId,
  });
  active.supplements = trimSupplements(active.supplements);
  active.controller.abort(new SupersededTurnError());
  active.controller = new AbortController();
  active.ownerToken = randomUUID();
  active.restartCount += 1;
  return active;
}

export async function runCoordinatedAgentTurn(input: RunCoordinatedAgentTurnInput): Promise<CoordinatedAgentTurnResult> {
  const now = input.now?.() ?? Date.now();
  const active = activeTurns.get(input.key)
    ? restartTurn(activeTurns.get(input.key)!, input, now)
    : createTurn(input, now);

  const ownerToken = active.ownerToken;
  const controller = active.controller;
  const workingHistory = cloneHistory(active.baseHistory);
  const mergedInput = buildInputWithSupplements(active.originalInput, active.supplements);
  const mergedImages = mergeImages(active);
  const runner = input.runner ?? runAgenticChat;

  try {
    const reply = await runner(workingHistory, mergedInput, input.user, {
      ...input.options,
      images: mergedImages,
      abortSignal: controller.signal,
    });

    if (activeTurns.get(input.key)?.ownerToken !== ownerToken) {
      return { status: 'superseded', reply: '', restartCount: active.restartCount };
    }

    replaceHistory(input.history, workingHistory);
    activeTurns.delete(input.key);
    return { status: 'completed', reply, restartCount: active.restartCount };
  } catch (err) {
    if (isSupersededTurnError(err)) {
      return { status: 'superseded', reply: '', restartCount: active.restartCount };
    }
    if (activeTurns.get(input.key)?.ownerToken === ownerToken) {
      activeTurns.delete(input.key);
    }
    throw err;
  }
}

export function cancelActiveAgentTurn(key: string, message = 'agent turn cancelled'): boolean {
  const active = activeTurns.get(key);
  if (!active) return false;
  active.controller.abort(new SupersededTurnError(message));
  activeTurns.delete(key);
  return true;
}

export function getActiveAgentTurnCount(): number {
  return activeTurns.size;
}

export function clearActiveAgentTurnsForTest(): void {
  activeTurns.clear();
}
