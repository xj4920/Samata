import Anthropic from '@anthropic-ai/sdk';
import { log } from '../utils/logger.js';

/** 流式事件 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'done'; content: Anthropic.ContentBlock[]; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } };

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
  usage?: { input_tokens: number; output_tokens: number };
}

export interface CreateMessageOptions {
  signal?: AbortSignal;
}

export interface LLMProvider {
  name: string;
  defaultModel: string;
  /** 可供 /model 命令枚举的模型白名单，可选 */
  availableModels?: string[];
  createMessage(params: CreateMessageParams, options?: CreateMessageOptions): Promise<CreateMessageResult>;
  createMessageStream?(params: CreateMessageParams, options?: CreateMessageOptions): AsyncGenerator<StreamEvent>;
  /** 将图片转为文字描述，imageDataUrl 格式为 data:image/xxx;base64,... */
  describeImage?(imageDataUrl: string, prompt: string): Promise<string>;
}

export type ProviderName = 'anthropic' | 'minimax' | 'gemini' | 'openrouter' | 'custom' | 'deepseek';

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

/** 任务类型定义 */
export type TaskType = 'extraction' | 'scoring' | 'classification' | 'summary';

/**
 * 根据任务类型获取对应的模型
 * 支持通过环境变量配置不同任务使用不同模型
 *
 * Fallback 使用 task provider 的 defaultModel（而非全局 getModelName()），
 * 避免 modelOverride 属于其他 provider 导致 model-provider 不匹配。
 */
export function getModelForTask(task: TaskType): string {
  const envModel: Record<TaskType, string | undefined> = {
    extraction: process.env.MODEL_EXTRACTION,
    scoring: process.env.MODEL_SCORING,
    classification: process.env.MODEL_CLASSIFICATION,
    summary: process.env.MODEL_SUMMARY,
  };

  if (envModel[task]) return envModel[task]!;

  return getProviderForTask(task).defaultModel;
}

/**
 * 获取 dream 分析专用的 provider / model 配置。
 * 通过 DREAM_PROVIDER / DREAM_MODEL 环境变量设置，未配置则 fallback 到全局 provider。
 */
export function getDreamProvider(): { provider: LLMProvider; model: string } {
  const dreamProviderName = (process.env.DREAM_PROVIDER || '') as ProviderName;
  const dreamModel = process.env.DREAM_MODEL || '';

  if (dreamProviderName) {
    const p = getProviderByName(dreamProviderName);
    if (p) {
      const model =
        dreamModel && p.availableModels?.includes(dreamModel)
          ? dreamModel
          : dreamModel || p.defaultModel;
      return { provider: p, model };
    }
    log.warn(
      `DREAM_PROVIDER=${dreamProviderName} 未注册或不可用，回退到全局 provider`
    );
  }

  return {
    provider: getProvider(),
    model: getModelName(),
  };
}

/**
 * 根据任务类型获取对应的 provider
 * 支持不同任务使用不同的 provider
 */
export function getProviderForTask(task: TaskType): LLMProvider {
  const providerMap: Record<TaskType, string> = {
    extraction: process.env.PROVIDER_EXTRACTION || '',
    scoring: process.env.PROVIDER_SCORING || '',
    classification: process.env.PROVIDER_CLASSIFICATION || '',
    summary: process.env.PROVIDER_SUMMARY || '',
  };

  const providerName = providerMap[task];
  if (providerName && providers.has(providerName as ProviderName)) {
    return providers.get(providerName as ProviderName)!;
  }

  return getProvider();
}

export function getAvailableProviders(): ProviderName[] {
  return [...providers.keys()];
}

/** 按名称获取 provider（不切换全局状态） */
export function getProviderByName(name: ProviderName): LLMProvider | undefined {
  return providers.get(name);
}

/**
 * 在所有已注册 provider 中搜索包含该 model 的 provider。
 * 只查 availableModels 白名单；未声明白名单的 provider 不参与匹配。
 * 命中返回 { provider, model }；无命中返回 null。
 */
export function getProviderForModel(modelName: string): { provider: LLMProvider; model: string } | null {
  for (const p of providers.values()) {
    if (p.availableModels && p.availableModels.includes(modelName)) {
      return { provider: p, model: modelName };
    }
  }
  return null;
}

let _initialized = false;

/**
 * 初始化所有可用的 provider，根据 LLM_PROVIDER env var 选择默认
 * 返回是否至少有一个 provider 可用
 * 幂等：多次调用只初始化一次
 */
export async function initProviders(): Promise<boolean> {
  if (_initialized) return providers.size > 0;

  // 延迟导入避免循环依赖
  const { createAnthropicProvider } = await import('./claude.js');
  const { createMinimaxProvider } = await import('./minimax.js');
  const { createGeminiProvider } = await import('./gemini.js');
  const { createOpenRouterProvider } = await import('./openrouter.js');
  const { createCustomProvider } = await import('./custom.js');
  const { createDeepseekProvider } = await import('./deepseek.js');
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

  // 尝试初始化 Gemini
  const gemini = createGeminiProvider();
  if (gemini) {
    registerProvider('gemini', gemini);
    log.dim('  Gemini provider 已注册');
  }

  // 尝试初始化 OpenRouter
  const openrouter = createOpenRouterProvider();
  if (openrouter) {
    registerProvider('openrouter', openrouter);
    log.dim('  OpenRouter provider 已注册');
  }

  // 尝试初始化自定义 OpenAI-compatible 网关
  const custom = createCustomProvider();
  if (custom) {
    registerProvider('custom', custom);
    log.dim('  Custom provider 已注册');
  }

  // 尝试初始化 DeepSeek
  const deepseek = createDeepseekProvider();
  if (deepseek) {
    registerProvider('deepseek', deepseek);
    log.dim('  DeepSeek provider 已注册');
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
  _initialized = true;
  return true;
}
