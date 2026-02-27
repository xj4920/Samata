import { isAdmin } from '../auth/rbac.js';
import { log } from '../utils/logger.js';
import * as clientCmd from './client.js';
import * as knowledgeCmd from './knowledge.js';
import * as monitorCmd from './monitor.js';
import * as tradeCmd from './trade.js';
import { runPlugin, listPlugins } from '../plugins/registry.js';
import { chat, resetConversation } from '../llm/agent.js';
import { handleSkill } from './skill.js';
import { startMonitor, stopMonitor, isMonitorRunning } from '../services/wework-monitor.js';

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
  add:     { description: '添加客户: /add <名称> [contact=xx] [wework_group=xx] [sales=xx]', adminOnly: true, handler: clientCmd.add },
  update:  { description: '更新客户: /update <id> <field=value ...>', adminOnly: true, handler: clientCmd.update },
  delete:  { description: '删除客户: /delete <id>', adminOnly: true, handler: clientCmd.remove },
  advance: { description: '推进状态: /advance <id>', adminOnly: true, handler: clientCmd.advance },
  list:    { description: '客户列表: /list [state=xx]', adminOnly: false, handler: clientCmd.list },
  view:    { description: '查看客户: /view <id>', adminOnly: false, handler: clientCmd.view },
  history: { description: '操作历史: /history <id>', adminOnly: false, handler: clientCmd.history },
  status:  { description: '状态看板: /status', adminOnly: false, handler: monitorCmd.status },
  trade:   { description: '交易查询: /trade [client=xx] [party=xx] [user=xx] [date=xx] [limit=N]', adminOnly: false, handler: tradeCmd.trade },
  faq:     { description: '查询知识库: /faq [关键词]', adminOnly: false, handler: knowledgeCmd.search },
  'faq-add': { description: '添加FAQ: /faq-add', adminOnly: true, handler: knowledgeCmd.add },
  'faq-del': { description: '删除FAQ: /faq-del <id>', adminOnly: true, handler: knowledgeCmd.remove },
  plugin:  { description: '插件: /plugin list | /plugin <name> [args]', adminOnly: false, handler: handlePlugin },
  skill:   { description: 'Skill: /skill list | save | run | del', adminOnly: false, handler: handleSkill },
  watch:   { description: '企微监控: /watch start | stop | status', adminOnly: true, handler: handleWatch },
  help:    { description: '显示帮助', adminOnly: false, handler: showHelp },
};

function handleWatch(args: string): void {
  const sub = args.trim().toLowerCase();
  if (sub === 'start') {
    startMonitor();
  } else if (sub === 'stop') {
    stopMonitor();
  } else if (sub === 'status') {
    log.info(isMonitorRunning() ? '[monitor] 运行中' : '[monitor] 未运行');
  } else {
    log.warn('用法: /watch start | stop | status');
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
  log.info('可用命令：');
  for (const [name, cmd] of Object.entries(commands)) {
    const tag = cmd.adminOnly ? ' [管理员]' : '';
    console.log(`  /${name.padEnd(10)} ${cmd.description}${tag}`);
  }
  if (llmEnabled) {
    console.log();
    log.dim('  也可以直接输入自然语言，AI 助手会帮你处理');
    log.dim('  输入 /reset 可重置 AI 对话上下文');
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
      log.warn(`未知输入，输入 /help 查看帮助`);
    }
    return;
  }

  const [slashCmd, ...rest] = trimmed.split(/\s+/);
  const cmd = slashCmd.slice(1); // remove leading /
  const args = rest.join(' ');

  // reset conversation
  if (cmd.toLowerCase() === 'reset') {
    resetConversation();
    log.success('AI 对话上下文已重置');
    return;
  }

  const command = commands[cmd.toLowerCase()];

  if (!command) {
    log.warn(`未知命令: ${slashCmd}，输入 /help 查看帮助`);
    return;
  }

  if (command.adminOnly && !isAdmin()) {
    log.error('权限不足：该命令需要管理员权限');
    return;
  }

  await command.handler(args);
}
