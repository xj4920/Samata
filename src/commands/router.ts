import { isSystemAdmin, isAgentAdmin } from '../auth/rbac.js';
import { getExecutionChannel, type AppChannel } from '../runtime/execution-context.js';
import { log } from '../utils/logger.js';
import * as knowledgeCmd from './knowledge.js';
import * as knowledgeTagAudit from './knowledge-tag-audit.js';
import * as documentImport from './document-import.js';
import * as monitorCmd from './monitor.js';
import { getLoadedPlugins } from '../plugins/registry.js';
import { chat, resetConversation, getCurrentAgent } from '../llm/agent.js';
import { handleModelCommand } from './model-cmd.js';
import { handleSkill } from './skill.js';
import { handleAgent, getAgentSubcommands } from './agent.js';
import { handleMemory } from './memory-cmd.js';
import { handleUser } from './user.js';
import { handleWrongQuestion } from './wrong-question.js';
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
  visibleWhen?: () => boolean;
  handler: (args: string) => Promise<void> | void;
  subcommands?: string[];
}

const commands: Record<string, Command> = {
  status:  { description: '系统状态', usage: '/status', handler: monitorCmd.status },
  faq:       { description: '查询知识库', usage: '/faq <关键词>', handler: knowledgeCmd.search },
  'faq-add':  { description: '添加FAQ', usage: '/faq-add <内容>', requiredRole: 'agent_admin', handler: (args) => knowledgeCmd.add(args, getCurrentAgent()?.id) },
  'faq-update': { description: '修改FAQ', usage: '/faq-update <id> <内容>', requiredRole: 'agent_admin', handler: knowledgeCmd.update },
  'faq-del':  { description: '删除FAQ', usage: '/faq-del <id>', requiredRole: 'agent_admin', handler: knowledgeCmd.remove },
  'faq-tags-check': {
    description: '核对知识标签与 monitor 白名单',
    usage: '/faq-tags-check',
    requiredRole: 'agent_admin',
    handler: () => knowledgeTagAudit.cliAuditKnowledgeTags(),
  },
  'doc-import': { description: '导入文档为知识', usage: '/doc-import <文件路径>', requiredRole: 'agent_admin', handler: documentImport.cliImport },
  'doc-list':   { description: '已导入的文档', usage: '/doc-list', handler: documentImport.cliList },
  'doc-del':    { description: '删除文档及知识', usage: '/doc-del <文档ID>', requiredRole: 'agent_admin', handler: documentImport.cliDelete },
  'doc-retag':  { description: '重生成文档标签', usage: '/doc-retag <文档ID|--all>', requiredRole: 'agent_admin', handler: documentImport.cliRetag },
  plugin:  { description: '插件', usage: '/plugin [list]', handler: handlePlugin, subcommands: ['list'] },
  skill:   { description: 'Skill', usage: '/skill <list|save|run|del> [名称]', handler: handleSkill, subcommands: ['list', 'save', 'run', 'del'] },
  agent:   { description: 'Agent', usage: '/agent <list|switch|info|...> [参数]', handler: handleAgent, subcommands: ['list', 'switch', 'info'] },
  memory:  { description: 'Memory', usage: '/memory <list|add|search|del> [内容]', handler: handleMemory, subcommands: ['list', 'add', 'search', 'del'] },
  wrongq:  {
    description: 'Tutor 错题集',
    usage: '/wrongq <list|show|mastered|report> [参数]',
    visibleWhen: () => getCurrentAgent()?.name === 'tutor',
    handler: handleWrongQuestion,
    subcommands: ['list', 'show', 'mastered', 'report'],
  },
  model:   { description: '切换模型', usage: '/model <list|<provider>|<provider>/<model>|reset>', requiredRole: 'agent_admin', handler: handleModel, subcommands: ['list', 'reset', 'anthropic', 'minimax', 'gemini', 'openrouter', 'gf'] },
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
  log.print(handleModelCommand(args, { scope: 'cli' }));
}

function handlePlugin(args: string): void {
  const sub = args.trim().toLowerCase();
  if (!sub || sub === 'list') {
    const plugins = getLoadedPlugins();
    if (plugins.length === 0) {
      log.print('暂无已加载插件（将 plugin 放入 plugins/ 目录即可自动加载）');
      return;
    }
    log.print('已加载插件：');
    for (const p of plugins) {
      log.print(`  ${p.name.padEnd(24)} ${p.description}`);
      log.print(`  ${''.padEnd(24)} tools: ${p.tools.join(', ')}${p.hasSkill ? ' | SKILL.md ✓' : ''}`);
    }
    return;
  }
  log.print('用法: /plugin list');
}

function shouldShowCommand(cmd: Command, channelOverride?: AppChannel): boolean {
  const channel = channelOverride ?? getExecutionChannel();
  if (cmd.cliOnly && channel !== 'cli') return false;
  if (cmd.visibleWhen && !cmd.visibleWhen()) return false;
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

export function getCommandEntries(channelOverride?: AppChannel): Array<{ name: string; description: string; usage?: string; subcommands?: string[] }> {
  const entries: Array<{ name: string; description: string; usage?: string; subcommands?: string[] }> = [];

  for (const [name, cmd] of Object.entries(commands)) {
    if (!shouldShowCommand(cmd, channelOverride)) continue;
    entries.push({
      name: `/${name}`,
      description: cmd.description,
      usage: cmd.usage,
      subcommands: name === 'agent' ? getAgentSubcommands() : cmd.subcommands,
    });
  }

  if ((channelOverride ?? getExecutionChannel()) === 'cli') {
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