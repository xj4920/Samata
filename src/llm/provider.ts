import Anthropic from '@anthropic-ai/sdk';
import { log } from '../utils/logger.js';

/** 流式事件 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'done'; content: Anthropic.ContentBlock[]; stop_reason: string };

/** 统一 LLM Provider 接口，内部格式复用 Anthropic 类型 */
export interface CreateMessageParams {
  model: string;
  max_tokens: number;
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}

export interface CreateMessageResult {
  content: Anthropic.ContentBlock[];
  stop_reason: string;
}

export interface LLMProvider {
  name: string;
  defaultModel: string;
  createMessage(params: CreateMessageParams): Promise<CreateMessageResult>;
  createMessageStream?(params: CreateMessageParams): AsyncGenerator<StreamEvent>;
}

export type ProviderName = 'anthropic' | 'minimax';

const providers = new Map<ProviderName, LLMProvider>();
let currentName: ProviderName = 'anthropic';
let currentProvider: LLMProvider | null = null;
let modelOverride: string | null = null;

export function registerProvider(name: ProviderName, provider: LLMProvider): void {
  providers.set(name, provider);
}

export function switchProvider(name: ProviderName): boolean {
  const p = providers.get(name);
  if (!p) return false;
  currentProvider = p;
  currentName = name;
  modelOverride = null; // 切换 provider 时重置 model override
  return true;
}

export function getProvider(): LLMProvider {
  if (!currentProvider) throw new Error('LLM provider 未初始化');
  return currentProvider;
}

export function getProviderName(): ProviderName {
  return currentName;
}

export function getModelName(): string {
  return modelOverride ?? getProvider().defaultModel;
}

export function setModelOverride(model: string | null): void {
  modelOverride = model;
}

export function getAvailableProviders(): ProviderName[] {
  return [...providers.keys()];
}

/**
 * 初始化所有可用的 provider，根据 LLM_PROVIDER env var 选择默认
 * 返回是否至少有一个 provider 可用
 */
export async function initProviders(): Promise<boolean> {
  // 延迟导入避免循环依赖
  const { createAnthropicProvider } = await import('./claude.js');
  const { createMinimaxProvider } = await import('./minimax.js');

  // 尝试初始化 Anthropic
  const anthropic = createAnthropicProvider();
  if (anthropic) {
    registerProvider('anthropic', anthropic);
    log.dim('  Anthropic provider 已注册');
  }

  // 尝试初始化 MiniMax
  const minimax = createMinimaxProvider();
  if (minimax) {
    registerProvider('minimax', minimax);
    log.dim('  MiniMax provider 已注册');
  }

  if (providers.size === 0) return false;

  // 选择默认 provider
  const preferred = (process.env.LLM_PROVIDER ?? 'anthropic') as ProviderName;
  if (!switchProvider(preferred)) {
    // fallback 到第一个可用的
    const first = providers.keys().next().value as ProviderName;
    switchProvider(first);
    log.warn(`LLM_PROVIDER=${preferred} 不可用，回退到 ${first}`);
  }

  // 支持 LLM_MODEL 覆盖默认模型
  if (process.env.LLM_MODEL) {
    setModelOverride(process.env.LLM_MODEL);
  }

  log.success(`AI 助手已启用 [${currentName}/${getModelName()}]`);
  return true;
}
