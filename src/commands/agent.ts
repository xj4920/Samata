import { getAllAgents, getAgent, saveAgent, deleteAgent, type AgentConfig } from '../llm/agents/config.js';
import { setCurrentAgent, getCurrentAgent, resetConversation } from '../llm/agent.js';
import { log } from '../utils/logger.js';
import { renderTable } from '../utils/table.js';

export async function handleAgent(args: string): Promise<void> {
  const match = args.match(/^(\S+)\s*(.*)/s);
  if (!match) {
    showHelp();
    return;
  }

  const sub = match[1].toLowerCase();
  const rest = match[2].trim();

  switch (sub) {
    case 'list': return listAgents();
    case 'switch': return switchAgent(rest);
    case 'info': return showInfo();
    case 'del':
    case 'delete': return delAgent(rest);
    default:
      // Treat unknown sub as agent name to switch to
      return switchAgent(sub);
  }
}

function showHelp(): void {
  log.print('Agent 用法：');
  log.print('  agent list                  列出所有 Agent');
  log.print('  agent switch <name>         切换当前会话的 Agent');
  log.print('  agent info                  查看当前 Agent 信息');
  log.print('  agent del <name>            删除 Agent');
}

function listAgents(): void {
  const agents = getAllAgents();
  if (agents.length === 0) {
    log.print('暂无已配置的 Agent');
    return;
  }

  const current = getCurrentAgent();
  const head = ['', '名称', '显示名', '描述', 'Tools 模式'];
  const rows = agents.map(a => [
    (current?.name ?? 'otcclaw') === a.name ? '→' : ' ',
    a.name,
    a.displayName,
    a.description ?? '-',
    a.toolsMode === 'all' ? '全部' : `${a.toolsMode}(${a.toolsList.length})`,
  ]);

  renderTable(head, rows);
  log.print(`共 ${agents.length} 个 Agent`);
}

function switchAgent(name: string): void {
  if (!name) {
    log.print('用法: agent switch <name>');
    return;
  }

  const agent = getAgent(name);
  if (agent.name !== name && name !== 'otcclaw') {
    log.print(`未找到 Agent: ${name}`);
    log.print('使用 agent list 查看所有可用 Agent');
    return;
  }

  // Clear history when switching agents
  resetConversation();
  setCurrentAgent(agent);
  log.print(`已切换到 Agent: ${agent.displayName} (${agent.name})`);
  if (agent.description) {
    log.print(`  ${agent.description}`);
  }
}

function showInfo(): void {
  const agent = getCurrentAgent();
  if (!agent) {
    log.print('当前使用默认 Agent: 衍语助手 (otcclaw)');
    log.print('  Tools: 全部');
    return;
  }

  log.print(`当前 Agent: ${agent.displayName} (${agent.name})`);
  if (agent.description) log.print(`  描述: ${agent.description}`);
  log.print(`  Tools 模式: ${agent.toolsMode}`);
  if (agent.toolsList.length > 0) {
    log.print(`  Tools 列表: ${agent.toolsList.join(', ')}`);
  }
  if (agent.model) log.print(`  模型: ${agent.model}`);
  if (agent.provider) log.print(`  Provider: ${agent.provider}`);
  log.print(`  最大历史: ${agent.maxHistory} 条`);
}

function delAgent(name: string): void {
  if (!name) {
    log.print('用法: agent del <name>');
    return;
  }
  const result = deleteAgent(name);
  if (!result.success) {
    log.print((result as any).error);
    return;
  }
  log.print(`Agent 已删除: ${name}`);

  // If deleted agent is currently active, reset
  const current = getCurrentAgent();
  if (current?.name === name) {
    resetConversation();
    setCurrentAgent(undefined);
    log.print('已切回默认 Agent');
  }
}
