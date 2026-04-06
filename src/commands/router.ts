import { isSystemAdmin, isAgentAdmin } from '../auth/rbac.js';
import { getExecutionChannel } from '../runtime/execution-context.js';
import { log } from '../utils/logger.js';
import * as knowledgeCmd from './knowledge.js';
import * as monitorCmd from './monitor.js';
import { runPlugin, listPlugins } from '../plugins/registry.js';
import { chat, resetConversation, getCurrentAgent } from '../llm/agent.js';
import { switchProvider, getProviderName, getModelName, getAvailableProviders, type ProviderName } from '../llm/provider.js';
import { handleSkill } from './skill.js';
import { handleAgent, getAgentSubcommands } from './agent.js';
import { handleMemory } from './memory-cmd.js';
import { handleUser } from './user.js';
import { startMonitor, stopMonitor, isMonitorRunning } from '../services/wework-monitor.js';
import { startTelegramBot, stopTelegramBot, isTelegramBotRunning } from '../telegram/bot.js';
import { startAllFeishuBots, stopAllFeishuBots, isFeishuBotRunning, type FeishuBotMode } from '../feishu/bot.js';

let llmEnabled = false;

export function setLlmEnabled(enabled: boolean): void {
  llmEnabled = enabled;
}

interface Command {
  description: string;
  usage?: string;
  cliOnly?: boolean;
  requiredRole?: 'system_admin' | 'agent_admin';
  handler: (args: string) => Promise<void> | void;
  subcommands?: string[];
}

const commands: Record<string, Command> = {
  status:  { description: '系统状态', usage: '/status', handler: monitorCmd.status },
  faq:       { description: '查询知识库', usage: '/faq <关键词>', handler: knowledgeCmd.search },
  'faq-add':  { description: '添加FAQ', usage: '/faq-add <内容>', requiredRole: 'agent_admin', handler: (args) => knowledgeCmd.add(args, getCurrentAgent()?.id) },
  'faq-update': { description: '修改FAQ', usage: '/faq-update <id> <内容>', requiredRole: 'agent_admin', handler: knowledgeCmd.update },
  'faq-del':  { description: '删除FAQ', usage: '/faq-del <id>', requiredRole: 'agent_admin', handler: knowledgeCmd.remove },
  plugin:  { description: '插件', usage: '/plugin <list|run> [名称]', handler: handlePlugin, subcommands: ['list'] },
  skill:   { description: 'Skill', usage: '/skill <list|save|run|del> [名称]', handler: handleSkill, subcommands: ['list', 'save', 'run', 'del'] },
  agent:   { description: 'Agent', usage: '/agent <list|switch|info|...> [参数]', handler: handleAgent, subcommands: ['list', 'switch', 'info'] },
  memory:  { description: 'Memory', usage: '/memory <list|add|search|del> [内容]', handler: handleMemory, subcommands: ['list', 'add', 'search', 'del'] },
  model:   { description: '切换模型', usage: '/model <list|anthropic|minimax|gemini|openrouter>', requiredRole: 'agent_admin', handler: handleModel, subcommands: ['list', 'anthropic', 'minimax', 'gemini', 'openrouter'] },
  watch:   { description: '企微监测', usage: '/watch <start|stop|status>', requiredRole: 'system_admin', cliOnly: true, handler: handleWatch, subcommands: ['start', 'stop', 'status'] },
  bot:     { description: 'Bot', usage: '/bot <tg|feishu> <start|stop|status>', requiredRole: 'system_admin', cliOnly: true, handler: handleBot, subcommands: ['tg start', 'tg stop', 'tg status', 'feishu start', 'feishu stop', 'feishu status'] },
  user:    { description: '系统用户', usage: '/user <list|add|update|delete>', requiredRole: 'system_admin', cliOnly: true, handler: handleUser, subcommands: ['list', 'add', 'update', 'delete'] },

  help:    { description: '显示帮助', usage: '/help', handler: showHelp },
};

function handleWatch(args: string): void {
  const sub = args.trim().toLowerCase();
  if (sub === 'start') {
    startMonitor();
  } else if (sub === 'stop') {
    stopMonitor();
  } else if (sub === 'status') {
    log.print(isMonitorRunning() ? '[monitor] 运行中' : '[monitor] 未运行');
  } else {
    log.print('用法: /watch start | stop | status');
  }
}

async function handleBot(args: string): Promise<void> {
  const parts = args.trim().toLowerCase().split(/\s+/);
  const channel = parts[0];
  const action = parts[1];

  if (!channel || !action) {
    log.print('用法: /bot <tg|feishu> <start|stop|status>');
    return;
  }

  if (channel === 'tg' || channel === 'telegram') {
    if (action === 'start') {
      await startTelegramBot();
    } else if (action === 'stop') {
      stopTelegramBot();
    } else if (action === 'status') {
      log.print(isTelegramBotRunning() ? '[Telegram] Bot 运行中' : '[Telegram] Bot 未运行');
    } else {
      log.print('用法: /bot tg <start|stop|status>');
    }
  } else if (channel === 'feishu' || channel === '飞书') {
    if (action === 'start') {
      const mode = (process.env.FEISHU_MODE || 'ws') as FeishuBotMode;
      const feishuPort = parseInt(process.env.FEISHU_PORT || '3001', 10);
      await startAllFeishuBots({
        mode,
        httpPort: mode === 'webhook' ? feishuPort : undefined,
      });
    } else if (action === 'stop') {
      stopAllFeishuBots();
    } else if (action === 'status') {
      log.print(isFeishuBotRunning() ? '[飞书] Bot 运行中' : '[飞书] Bot 未运行');
    } else {
      log.print('用法: /bot feishu <start|stop|status>');
    }
  } else {
    log.print('未知 channel: tg, feishu');
  }
}

function handleModel(args: string): void {
  const sub = args.trim().toLowerCase();
  if (!sub || sub === 'list') {
    const available = getAvailableProviders();
    const current = getProviderName();
    log.print(`当前: ${current} / ${getModelName()}`);
    log.print('可用 provider:');
    for (const p of available) {
      log.print(`  ${p === current ? '▶' : ' '} ${p}`);
    }
  } else {
    const ok = switchProvider(sub as ProviderName);
    if (ok) {
      log.print(`已切换到 ${getProviderName()} / ${getModelName()}`);
    } else {
      log.print(`未知 provider: ${sub}，可用: ${getAvailableProviders().join(', ')}`);
    }
  }
}

async function handlePlugin(args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (!parts[0] || parts[0] === 'list') {
    listPlugins();
    return;
  }
  await runPlugin(parts[0], parts.slice(1).join(' '));
}

function shouldShowCommand(cmd: Command): boolean {
  if (cmd.cliOnly && getExecutionChannel() !== 'cli') return false;
  if (cmd.requiredRole === 'system_admin' && !isSystemAdmin()) return false;
  if (cmd.requiredRole === 'agent_admin') {
    const agentId = getCurrentAgent()?.id;
    if (!agentId || !isAgentAdmin(agentId)) return false;
  }
  return true;
}

function showHelp(): void {
  log.print('可用命令：');
  for (const [name, cmd] of Object.entries(commands)) {
    if (!shouldShowCommand(cmd)) continue;
    log.print(`  /${name.padEnd(10)} ${cmd.description}`);
    if (cmd.usage) log.print(`  ${''.padEnd(10)}   用法: ${cmd.usage}`);
  }
  if (llmEnabled) {
    log.print();
    log.print('  也可以直接输入自然语言，AI 助手会帮你处理');
    log.print('  输入 /reset 可重置 AI 对话上下文');
  }
}

export function getCommandNames(): string[] {
  return Object.entries(commands)
    .filter(([, cmd]) => shouldShowCommand(cmd))
    .map(([name]) => `/${name}`);
}

export function getCommandEntries(): Array<{ name: string; description: string; usage?: string; subcommands?: string[] }> {
  const entries: Array<{ name: string; description: string; usage?: string; subcommands?: string[] }> = [];

  for (const [name, cmd] of Object.entries(commands)) {
    if (!shouldShowCommand(cmd)) continue;
    entries.push({
      name: `/${name}`,
      description: cmd.description,
      usage: cmd.usage,
      subcommands: name === 'agent' ? getAgentSubcommands() : cmd.subcommands,
    });
  }

  if (getExecutionChannel() === 'cli') {
    entries.push({ name: '/reload', description: '重载代码（热重启）' });
    entries.push({ name: '/exit', description: '退出程序' });
  }
  entries.push({ name: '/reset', description: '重置 AI 对话上下文' });
  return entries;
}

export async function route(input: string): Promise<void> {
  const trimmed = input.trim();

  // Handle "/" as a shortcut for help
  if (trimmed === '/') {
    showHelp();
    return;
  }

  // Commands must start with /
  if (!trimmed.startsWith('/')) {
    // Natural language fallback to LLM
    if (llmEnabled) {
      await chat(trimmed);
    } else {
      log.print(`未知输入，输入 /help 查看帮助`);
    }
    return;
  }

  const [slashCmd, ...rest] = trimmed.split(/\s+/);
  const cmd = slashCmd.slice(1); // remove leading /
  const args = rest.join(' ');

  if (cmd.toLowerCase() === 'reload') {
    log.print('正在重载...');
    const { gracefulShutdown } = await import('../index.js');
    gracefulShutdown();
    process.exit(120);
  }

  if (cmd.toLowerCase() === 'reset') {
    resetConversation();
    log.print('AI 对话上下文已重置');
    return;
  }

  const command = commands[cmd.toLowerCase()];

  if (!command || !shouldShowCommand(command)) {
    log.print(`未知命令: ${slashCmd}，输入 /help 查看帮助`);
    return;
  }

  await command.handler(args);
}