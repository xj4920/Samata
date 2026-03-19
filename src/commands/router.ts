import { isAdmin } from '../auth/rbac.js';
import { log } from '../utils/logger.js';
import * as clientCmd from './client.js';
import * as knowledgeCmd from './knowledge.js';
import * as monitorCmd from './monitor.js';
import * as tradeCmd from './trade.js';
import * as plotCmd from './plot.js';
import * as weworkQACmd from './wework-qa.js';
import { runPlugin, listPlugins } from '../plugins/registry.js';
import { chat, resetConversation, getCurrentAgent } from '../llm/agent.js';
import { switchProvider, getProviderName, getModelName, getAvailableProviders, type ProviderName } from '../llm/provider.js';
import { handleSkill } from './skill.js';
import { handleAgent } from './agent.js';
import { handleMemory } from './memory-cmd.js';
import { startMonitor, stopMonitor, isMonitorRunning } from '../services/wework-monitor.js';
import { startTelegramBot, stopTelegramBot, isTelegramBotRunning } from '../telegram/bot.js';
import { startAllFeishuBots, stopAllFeishuBots, isFeishuBotRunning, type FeishuBotMode } from '../feishu/bot.js';

let llmEnabled = false;

export function setLlmEnabled(enabled: boolean): void {
  llmEnabled = enabled;
}

interface Command {
  description: string;
  adminOnly: boolean;
  agentId?: string; // 如果设置，仅在该 agent 下可见和可用。如 'alter-ego'
  handler: (args: string) => Promise<void> | void;
  subcommands?: string[];
}

const commands: Record<string, Command> = {
  client:  { description: '客户管理', adminOnly: false, agentId: 'otcclaw', handler: clientCmd.handleClient, subcommands: ['list', 'view', 'history', 'add', 'update', 'delete', 'advance', 'rollback'] },
  status:  { description: '系统状态', adminOnly: false, handler: monitorCmd.status },
  trade:   { description: '交易查询', adminOnly: false, agentId: 'otcclaw', handler: tradeCmd.trade },
  plot:    { description: '交易曲线图', adminOnly: false, agentId: 'otcclaw', handler: plotCmd.handlePlot },
  'wework-qa': { description: '企微Q&A提取', adminOnly: false, agentId: 'alter-ego', handler: weworkQACmd.weworkQA },
  faq:       { description: '查询知识库', adminOnly: false, agentId: 'otcclaw', handler: knowledgeCmd.search },
  'faq-add':  { description: '添加FAQ', adminOnly: true, agentId: 'otcclaw', handler: (args) => knowledgeCmd.add(args, getCurrentAgent()?.id) },
  'faq-update': { description: '修改FAQ', adminOnly: true, agentId: 'otcclaw', handler: knowledgeCmd.update },
  'faq-del':  { description: '删除FAQ', adminOnly: true, agentId: 'otcclaw', handler: knowledgeCmd.remove },
  plugin:  { description: '插件', adminOnly: false, handler: handlePlugin, subcommands: ['list'] },
  skill:   { description: 'Skill', adminOnly: false, handler: handleSkill, subcommands: ['list', 'save', 'run', 'del'] },
  agent:   { description: 'Agent', adminOnly: false, handler: handleAgent, subcommands: ['list', 'create', 'switch', 'info', 'del'] },
  memory:  { description: 'Memory', adminOnly: false, handler: handleMemory, subcommands: ['list', 'add', 'search', 'del'] },
  watch:   { description: '企微监测', adminOnly: true, agentId: 'alter-ego', handler: handleWatch, subcommands: ['start', 'stop', 'status'] },
  bot:     { description: 'Bot', adminOnly: true, handler: handleBot, subcommands: ['tg start', 'tg stop', 'tg status', 'feishu start', 'feishu stop', 'feishu status'] },
  model:   { description: '切换模型', adminOnly: true, handler: handleModel, subcommands: ['list', 'anthropic', 'minimax', 'gemini', 'openrouter'] },
  help:    { description: '显示帮助', adminOnly: false, handler: showHelp },
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

function showHelp(): void {
  const currentAgent = getCurrentAgent();
  log.print('可用命令：');
  for (const [name, cmd] of Object.entries(commands)) {
    if (cmd.agentId && currentAgent?.name !== cmd.agentId) {
      continue;
    }
    const tag = cmd.adminOnly ? ' [管理员]' : '';
    log.print(`  /${name.padEnd(10)} ${cmd.description}${tag}`);
  }
  if (llmEnabled) {
    log.print();
    log.print('  也可以直接输入自然语言，AI 助手会帮你处理');
    log.print('  输入 /reset 可重置 AI 对话上下文');
  }
}

export function getCommandNames(): string[] {
  return Object.keys(commands).map(name => `/${name}`);
}

export function getCommandEntries(): Array<{ name: string; description: string; subcommands?: string[] }> {
  const currentAgent = getCurrentAgent();
  const entries: Array<{ name: string; description: string; subcommands?: string[] }> = [];
  
  for (const [name, cmd] of Object.entries(commands)) {
    // If command requires a specific agent, skip it if not in that agent
    if (cmd.agentId && currentAgent?.name !== cmd.agentId) {
      continue;
    }
    entries.push({
      name: `/${name}`,
      description: cmd.description,
      subcommands: cmd.subcommands,
    });
  }
  
  entries.push({ name: '/reload', description: '重载代码（热重启）' });
  entries.push({ name: '/exit', description: '退出程序' });
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

  if (!command) {
    log.print(`未知命令: ${slashCmd}，输入 /help 查看帮助`);
    return;
  }

  const currentAgent = getCurrentAgent();
  if (command.agentId && currentAgent?.name !== command.agentId) {
    log.print(`未知命令: ${slashCmd}，输入 /help 查看帮助`);
    return;
  }

  if (command.adminOnly && !isAdmin()) {
    log.print('权限不足：该命令需要管理员权限');
    return;
  }

  await command.handler(args);
}
