/**
 * 统一 /model 命令处理逻辑
 *
 * 四个入口（CLI / 企微 / 飞书 / Telegram）共用一套语法：
 *   /model                     → 列出当前绑定 + 可用 provider 与 availableModels
 *   /model list                → 同上
 *   /model <provider>          → 切 provider，model 回退为该 provider 的 defaultModel
 *   /model <provider>/<model>  → 同时设 provider + model
 *   /model <model>             → 命中某个 provider.availableModels 时只换 model
 *   /model reset               → 清空 bot 级绑定（仅 bot 场景有效）
 *
 * 作用域：
 *   - scope='cli'：调用全局 switchProvider + setModelOverride（影响全局默认）
 *   - scope='bot'：写入 bot_apps.config.llm（仅该 bot 实例生效）
 */
import {
  getAvailableProviders,
  getProviderByName,
  getProviderName,
  getModelName,
  getProviderForModel,
  switchProvider,
  setModelOverride,
  type ProviderName,
} from '../llm/provider.js';
import { getBotApp, getBotAppLLM, setBotAppLLM } from '../llm/agents/config.js';

export interface ModelContext {
  scope: 'cli' | 'bot';
  botAppId?: string;
}

/**
 * 格式化 model 显示：如果 provider 在已注册 provider 里且有 availableModels，
 * 返回 `<provider>/<model>`；否则只返回 model 名本身。
 */
export function formatProviderModel(providerName: string, modelName: string): string {
  const p = getProviderByName(providerName as ProviderName);
  if (p?.availableModels) return `${providerName}/${modelName}`;
  return modelName;
}

function listText(ctx: ModelContext): string {
  const available = getAvailableProviders();
  const globalProvider = getProviderName();
  const globalModel = getModelName();

  const lines: string[] = [];

  if (ctx.scope === 'bot' && ctx.botAppId) {
    const bound = getBotAppLLM(ctx.botAppId);
    if (bound.provider || bound.model) {
      const effProvider = bound.provider ?? globalProvider;
      const effModel = bound.model ?? (getProviderByName(effProvider as ProviderName)?.defaultModel ?? globalModel);
      lines.push(`当前 bot: ${formatProviderModel(effProvider, effModel)}（bot 级绑定）`);
      lines.push(`全局默认: ${formatProviderModel(globalProvider, globalModel)}`);
    } else {
      lines.push(`当前 bot: ${formatProviderModel(globalProvider, globalModel)}（沿用全局默认）`);
    }
  } else {
    lines.push(`当前: ${formatProviderModel(globalProvider, globalModel)}`);
  }

  lines.push('');
  lines.push('可用 provider 与模型:');
  for (const name of available) {
    const p = getProviderByName(name)!;
    const marker = name === globalProvider ? '▶' : ' ';
    if (p.availableModels && p.availableModels.length > 0) {
      lines.push(`${marker} ${name}`);
      for (const m of p.availableModels) {
        lines.push(`    - ${name}/${m}`);
      }
    } else {
      lines.push(`${marker} ${name} (默认 ${p.defaultModel})`);
    }
  }

  lines.push('');
  lines.push('用法:');
  lines.push('  /model <provider>              切 provider，模型回默认');
  lines.push('  /model <provider>/<model>      同时设 provider + model');
  lines.push('  /model <model>                 仅换模型（需命中已知白名单）');
  if (ctx.scope === 'bot') {
    lines.push('  /model reset                   清空 bot 绑定，回退全局默认');
  }
  return lines.join('\n');
}

function applyCli(provider: ProviderName, model: string | null): string {
  if (!switchProvider(provider)) {
    return `未知 provider: ${provider}\n可用: ${getAvailableProviders().join(', ')}`;
  }
  setModelOverride(model);
  return `已切换到 ${formatProviderModel(getProviderName(), getModelName())}（全局生效）`;
}

function applyBot(appId: string, provider: ProviderName | null, model: string | null): string {
  setBotAppLLM(appId, { provider, model });
  const bound = getBotAppLLM(appId);
  if (!bound.provider && !bound.model) {
    return `已清空 bot 级模型绑定，回退全局默认 (${formatProviderModel(getProviderName(), getModelName())})`;
  }
  const effProvider = bound.provider ?? getProviderName();
  const effModel = bound.model ?? (getProviderByName(effProvider as ProviderName)?.defaultModel ?? getModelName());
  return `已切换到 ${formatProviderModel(effProvider, effModel)}（仅本 bot 生效）`;
}

export function handleModelCommand(args: string, ctx: ModelContext): string {
  if (ctx.scope === 'bot' && !ctx.botAppId) {
    return '内部错误: bot 作用域缺少 botAppId';
  }
  if (ctx.scope === 'bot' && ctx.botAppId && !getBotApp(ctx.botAppId)) {
    return `未找到 bot_apps: ${ctx.botAppId}`;
  }

  const arg = args.trim();

  if (!arg || arg.toLowerCase() === 'list') {
    return listText(ctx);
  }

  if (arg.toLowerCase() === 'reset') {
    if (ctx.scope === 'cli') {
      setModelOverride(null);
      return `全局 model override 已清空，当前: ${formatProviderModel(getProviderName(), getModelName())}`;
    }
    return applyBot(ctx.botAppId!, null, null);
  }

  const available = getAvailableProviders();

  // <provider>/<model>
  const slashIdx = arg.indexOf('/');
  if (slashIdx > 0) {
    const providerStr = arg.slice(0, slashIdx).trim();
    const modelStr = arg.slice(slashIdx + 1).trim();
    if (!available.includes(providerStr as ProviderName)) {
      return `未知 provider: ${providerStr}\n可用: ${available.join(', ')}`;
    }
    const p = getProviderByName(providerStr as ProviderName)!;
    if (p.availableModels && p.availableModels.length > 0 && !p.availableModels.includes(modelStr)) {
      return `未知模型: ${providerStr}/${modelStr}\n${providerStr} 支持: ${p.availableModels.join(', ')}`;
    }
    if (ctx.scope === 'cli') return applyCli(providerStr as ProviderName, modelStr);
    return applyBot(ctx.botAppId!, providerStr as ProviderName, modelStr);
  }

  // 仅 provider
  if (available.includes(arg as ProviderName)) {
    if (ctx.scope === 'cli') return applyCli(arg as ProviderName, null);
    return applyBot(ctx.botAppId!, arg as ProviderName, null);
  }

  // 仅 model：在已注册 provider 的 availableModels 白名单里查
  const hit = getProviderForModel(arg);
  if (hit) {
    if (ctx.scope === 'cli') return applyCli(hit.provider.name as ProviderName, hit.model);
    return applyBot(ctx.botAppId!, hit.provider.name as ProviderName, hit.model);
  }

  return `未识别的参数: ${arg}\n可用 provider: ${available.join(', ')}\n或使用 <provider>/<model> 形式`;
}
