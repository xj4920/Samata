import { isAdmin } from '../auth/rbac.js';
import { log } from '../utils/logger.js';
import * as clientCmd from './client.js';
import * as knowledgeCmd from './knowledge.js';
import * as monitorCmd from './monitor.js';
import * as tradeCmd from './trade.js';
import * as plotCmd from './plot.js';
import * as weworkQACmd from './wework-qa.js';
import { runPlugin, listPlugins } from '../plugins/registry.js';
import { chat, resetConversation } from '../llm/agent.js';
import { switchProvider, getProviderName, getModelName, getAvailableProviders, type ProviderName } from '../llm/provider.js';
import { handleSkill } from './skill.js';
import { handleAgent } from './agent.js';
import { handleMemory } from './memory-cmd.js';
import { startMonitor, stopMonitor, isMonitorRunning } from '../services/wework-monitor.js';
import { startTelegramBot, stopTelegramBot, isTelegramBotRunning } from '../telegram/bot.js';
import { startFeishuBot, stopFeishuBot, isFeishuBotRunning, type FeishuBotMode } from '../feishu/bot.js';

let llmEnabled = false;

export function setLlmEnabled(enabled: boolean): void {
  llmEnabled = enabled;
}

interface Command {
  description: string;
  adminOnly: boolean;
  handler: (args: string) => Promise<void> | void;
}

const commands: Record<string, Command> = {
  client:  { description: '客户管理: /client list|view|history|add|update|delete|advance|rollback', adminOnly: false, handler: clientCmd.handleClient },
  status:  { description: '系统状态: /status', adminOnly: false, handler: monitorCmd.status },
  trade:   { description: '交易查询: /trade [client=xx] [party=xx] [user=xx] [date=xx] [limit=N]', adminOnly: false, handler: tradeCmd.trade },
  plot:    { description: '交易曲线图: /plot client=xx|party=xx [limit=N]', adminOnly: false, handler: plotCmd.handlePlot },
  'wework-qa': { description: '企微Q&A提取: /wework-qa topics=关键词1,关键词2 [people=人1,人2] [start=日期] [end=日期] [session=群名] [limit=N]', adminOnly: false, handler: weworkQACmd.weworkQA },
  faq:       { description: '查询知识库: /faq [关键词]', adminOnly: false, handler: knowledgeCmd.search },
  'faq-add':  { description: '添加FAQ: /faq-add', adminOnly: true, handler: knowledgeCmd.add },
  'faq-update': { description: '修改FAQ: /faq-update <id>', adminOnly: true, handler: knowledgeCmd.update },
  'faq-del':  { description: '删除FAQ: /faq-del <id>', adminOnly: true, handler: knowledgeCmd.remove },
  plugin:  { description: '插件: /plugin list | /plugin <name> [args]', adminOnly: false, handler: handlePlugin },
  skill:   { description: 'Skill: /skill list | save | run | del', adminOnly: false, handler: handleSkill },
  agent:   { description: 'Agent: /agent list | switch | info | del', adminOnly: false, handler: handleAgent },
  memory:  { description: 'Memory: /memory list | add | search | del', adminOnly: false, handler: handleMemory },
  watch:   { description: '企微监控: /watch start | stop | status', adminOnly: true, handler: handleWatch },
  bot:     { description: 'Bot: /bot <tg|feishu> <start|stop|status>', adminOnly: true, handler: handleBot },
  model:   { description: '切换模型: /model [list | <provider>]', adminOnly: true, handler: handleModel },
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
      await startFeishuBot({
        mode,
        httpPort: mode === 'webhook' ? feishuPort : undefined,
      });
    } else if (action === 'stop') {
      stopFeishuBot();
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
  log.print('可用命令：');
  for (const [name, cmd] of Object.entries(commands)) {
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

export function getCommandEntries(): Array<{ name: string; description: string }> {
  const entries = Object.entries(commands).map(([name, cmd]) => ({
    name: `/${name}`,
    description: cmd.description,
  }));
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

  if (command.adminOnly && !isAdmin()) {
    log.print('权限不足：该命令需要管理员权限');
    return;
  }

  await command.handler(args);
}
