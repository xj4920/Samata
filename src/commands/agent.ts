import { getAllAgents, getAgent, saveAgent, deleteAgent, manageAgentMember, listAgentMembers, getAgentTools, saveAssignment, deleteAssignment, listAssignments, getBotApp, saveBotApp, getBotAppsByChannel, type BotAppRow, type AgentConfig, TOOL_PRESETS, COMMON_SET } from '../llm/agents/config.js';
import { setCurrentAgent, getCurrentAgent, resetConversation, getGlobalTools } from '../llm/agent.js';
import { isSystemAdmin, isAgentAdmin } from '../auth/rbac.js';
import { log } from '../utils/logger.js';
import { renderTable } from '../utils/table.js';
import { isInteractive, remoteInput, remoteSelect, remoteConfirm } from '../runtime/execution-context.js';
import { getDb } from '../db/connection.js';

export async function handleAgent(args: string): Promise<void> {
  const match = args.match(/^(\S+)\s*(.*)/s);
  if (!match) {
    showHelp();
    return;
  }

  const sub = match[1].toLowerCase();
  const rest = match[2].trim();

  const agentId = getCurrentAgent()?.id;
  const isSysAdmin = isSystemAdmin();
  const isAAdmin = agentId ? isAgentAdmin(agentId) : false;

  switch (sub) {
    case 'list': return listAgents();
    case 'switch': return switchAgent(rest);
    case 'info': return showInfo();
    case 'member':
      if (!isAAdmin) { log.print('权限不足：需要 Agent 管理员权限'); return; }
      return manageMembers(rest);
    case 'create':
      if (!isSysAdmin) { log.print('权限不足：需要系统管理员权限'); return; }
      return createAgent();
    case 'del':
    case 'delete':
      if (!isSysAdmin) { log.print('权限不足：需要系统管理员权限'); return; }
      return delAgent(rest);
    case 'assign':
      if (!isSysAdmin) { log.print('权限不足：需要系统管理员权限'); return; }
      return assignAgent(rest);
    case 'unassign':
      if (!isSysAdmin) { log.print('权限不足：需要系统管理员权限'); return; }
      return unassignAgent(rest);
    case 'assignments':
      if (!isSysAdmin) { log.print('权限不足：需要系统管理员权限'); return; }
      return listAssignmentsCmd();
    case 'bot-app':
    case 'feishu-app':
      if (!isSysAdmin) { log.print('权限不足：需要系统管理员权限'); return; }
      return manageBotApp(rest);
    default:
      return switchAgent(sub);
  }
}

/** Returns the visible subcommands for /agent based on current user role */
export function getAgentSubcommands(): string[] {
  const subs = ['list', 'switch', 'info'];
  const agentId = getCurrentAgent()?.id;
  if (agentId && isAgentAdmin(agentId)) {
    subs.push('member');
  }
  if (isSystemAdmin()) {
    subs.push('create', 'del', 'assign', 'unassign', 'assignments', 'bot-app');
  }
  return subs;
}

function showHelp(): void {
  const agentId = getCurrentAgent()?.id;
  const isSysAdmin = isSystemAdmin();
  const isAAdmin = agentId ? isAgentAdmin(agentId) : false;

  log.print('Agent 用法：');
  log.print('  agent list                  列出所有 Agent');
  log.print('  agent switch <name>         切换当前会话的 Agent');
  log.print('  agent info                  查看当前 Agent 信息');
  if (isAAdmin) {
    log.print('  agent member <list|add|del> <agent_name> <username> [role]  管理 Agent 成员');
  }
  if (isSysAdmin) {
    log.print('  agent create                创建新 Agent（交互向导）');
    log.print('  agent del <name>            删除 Agent');
    log.print('  agent assign <name> feishu <app_id>        绑定 Agent 到飞书应用');
    log.print('  agent assign <name> telegram [user_id]     绑定 Agent 到 Telegram 用户');
    log.print('  agent assign <name> wework [bot_id]        绑定 Agent 到企微 Bot');
    log.print('  agent unassign feishu <app_id>             移除飞书应用绑定');
    log.print('  agent unassign telegram [user_id]          移除 Telegram 用户绑定');
    log.print('  agent unassign wework [bot_id]             移除企微 Bot 绑定');
    log.print('  agent assignments                          列出所有绑定');
    log.print('  agent bot-app list [channel]               列出 Bot 应用');
    log.print('  agent bot-app start <id>                   启动 Bot');
    log.print('  agent bot-app stop <id>                    停止 Bot');
  }
}

async function createAgent(): Promise<void> {
  if (!isInteractive()) {
    log.print('此命令需要交互式终端');
    return;
  }

  log.print('=== 创建新 Agent ===');

  const name = await remoteInput('Agent 名称（英文，唯一）:');
  if (!name.trim()) { log.print('名称不能为空'); return; }
  if (!/^[a-z0-9-]+$/.test(name.trim())) { log.print('只允许小写字母、数字和连字符'); return; }
  if (getAllAgents().find(a => a.name === name.trim())) { log.print(`名称已存在: ${name.trim()}`); return; }

  const displayName = await remoteInput('显示名称:');
  if (!displayName.trim()) { log.print('显示名称不能为空'); return; }

  const description = await remoteInput('描述（可选）:');

  const toolsModeChoice = await remoteSelect('工具配置方式:', [
    { name: `标准模式 (COMMON_SET ${COMMON_SET.size} 个基础工具)`, value: 'standard' },
    { name: '标准 + 额外允许工具', value: 'standard-allow' },
    { name: '全部工具（all）', value: 'all' },
  ]);

  let toolsMode: 'all' | 'standard' = toolsModeChoice === 'all' ? 'all' : 'standard';
  let toolsList: string[] | undefined;
  let blockTools: string[] | undefined;

  if (toolsModeChoice === 'standard-allow') {
    const globalTools = getGlobalTools();
    const nonCommon = globalTools.map(t => t.name).filter(n => !COMMON_SET.has(n));
    log.print(`  COMMON_SET 之外的可选工具: ${nonCommon.join(', ')}`);
    const toolsInputStr = await remoteInput('输入额外允许的工具名称（逗号分隔）:');
    toolsList = toolsInputStr ? toolsInputStr.split(',').map(t => t.trim()).filter(Boolean) : [];

    const blockInput = await remoteInput('输入要从 COMMON_SET 中排除的工具名称（逗号分隔，可留空）:');
    blockTools = blockInput ? blockInput.split(',').map(t => t.trim()).filter(Boolean) : [];
  }

  const systemPrompt = await remoteInput('系统提示词（可选，留空使用默认）:');
  const model = await remoteInput('模型（可选，留空使用全局默认）:');
  const provider = await remoteInput('Provider（可选，留空使用全局默认）:');

  log.print('\n=== 确认信息 ===');
  log.print(`  名称: ${name}`);
  log.print(`  显示名: ${displayName}`);
  if (description) log.print(`  描述: ${description}`);
  log.print(`  工具模式: ${toolsMode}${toolsList ? ` (${toolsList.length} 个)` : ''}`);
  if (systemPrompt) log.print(`  系统提示词: ${systemPrompt.slice(0, 50)}...`);
  if (model) log.print(`  模型: ${model}`);
  if (provider) log.print(`  Provider: ${provider}`);

  const ok = await remoteConfirm('确认创建？');
  if (!ok) {
    log.print('已取消');
    return;
  }

  const result = saveAgent({
    name,
    displayName,
    description: description || undefined,
    systemPrompt: systemPrompt || undefined,
    model: model || undefined,
    provider: provider || undefined,
    toolsMode,
    toolsList,
    blockTools,
  });

  if (!result.success) {
    log.print(`创建失败: ${(result as any).error}`);
    return;
  }
  log.print(`Agent 已创建: ${displayName} (${name})`);
}

function manageMembers(args: string): void {
    const parts = args.split(/\s+/);
    if (parts.length < 2) {
        log.print('用法: agent member <list|add|del> <agent_name> [username] [role]');
        return;
    }

    const action = parts[0];
    const agentName = parts[1];

    if (action === 'list') {
        const result = listAgentMembers(agentName);
        if (!result.success) {
            log.print(result.error);
            return;
        }
        if (result.data.length === 0) {
            log.print(`Agent ${agentName} 暂无成员`);
            return;
        }
        const rows = result.data.map(m => [m.username, m.id, m.role, m.created_at]);
        renderTable(['用户名', '用户ID', '角色', '添加时间'], rows);
        log.print(`共 ${result.data.length} 个成员`);
        return;
    }

    if (parts.length < 3) {
        log.print('用法: agent member <add|del> <agent_name> <username> [role]');
        return;
    }
    
    const username = parts[2];
    const roleInput = parts[3];
    const role = (roleInput === 'user') ? 'user' : 'admin';
    
    const result = manageAgentMember(action as 'add' | 'del', agentName, username, role);
    if (!result.success) {
        log.print(result.error);
        return;
    }
    log.print(`已成功${action === 'add' ? '添加' : '移除'}成员: ${username} (${agentName})`);
}

function listAgents(): void {
  const agents = getAllAgents();
  if (agents.length === 0) {
    log.print('暂无已配置的 Agent');
    return;
  }

  const current = getCurrentAgent();
  const globalTools = getGlobalTools();
  const head = ['', 'ID', '名称', '显示名', '描述', 'Tools (可用数量)'];
  const rows = agents.map(a => {
    const availableTools = getAgentTools(a, globalTools);
    return [
      (current?.name ?? 'otcclaw') === a.name ? '→' : ' ',
      a.id.slice(0, 8),
      a.name,
      a.displayName,
      a.description ?? '-',
      `${a.toolsMode} (${availableTools.length})`,
    ];
  });

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
  const globalTools = getGlobalTools();
  if (!agent) {
    log.print('当前使用默认 Agent: 衍语助手 (otcclaw)');
    log.print(`  Tools: 全部 (${globalTools.length})`);
    log.print(`  可用工具列表: ${globalTools.map(t => t.name).join(', ')}`);
    return;
  }

  const availableTools = getAgentTools(agent, globalTools);
  log.print(`当前 Agent: ${agent.displayName} (${agent.name})`);
  if (agent.description) log.print(`  描述: ${agent.description}`);
  log.print(`  Tools 模式: ${agent.toolsMode} (${availableTools.length})`);
  if (availableTools.length > 0) {
    log.print(`  可用工具列表: ${availableTools.map(t => t.name).join(', ')}`);
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

async function assignAgent(args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    log.print('用法:');
    log.print('  agent assign <agent_name> feishu <app_id>');
    log.print('  agent assign <agent_name> telegram [user_id]');
    log.print('  agent assign <agent_name> wework [bot_id]');
    return;
  }

  const [agentName, channel, identifier] = parts;

  let appId: string | undefined;
  let targetId: string | undefined;

  if (channel === 'feishu' || channel === 'wework') {
    if (channel === 'feishu' && !identifier) {
      log.print('❌ 飞书渠道需要指定 app_id');
      return;
    }
    appId = identifier;

    if (appId) {
      const existing = getBotApp(appId);
      if (!existing) {
        if (!isInteractive()) {
          log.print(`"${appId}" 不在 bot_apps 中，请在交互式终端中执行此操作以填写应用信息`);
          return;
        }
        log.print(`⚠️  "${appId}" 不在 bot_apps 中，请填写应用信息：`);
        const appName = await remoteInput('App 名称:');
        if (!appName.trim()) { log.print('名称不能为空'); return; }
        const appSecret = await remoteInput('Secret:');
        if (!appSecret.trim()) { log.print('Secret 不能为空'); return; }
        let config = '{}';
        if (channel === 'feishu') {
          const verificationToken = await remoteInput('Verification Token（可选）:');
          const encryptKey = await remoteInput('Encrypt Key（可选）:');
          config = JSON.stringify({ verification_token: verificationToken.trim(), encrypt_key: encryptKey.trim() });
        }
        const showThinking = await remoteConfirm('显示思考过程?');
        const autoStart = await remoteConfirm('启动时自动启动此 Bot?');
        saveBotApp({
          id: appId,
          channel,
          name: appName.trim(),
          secret: appSecret.trim(),
          config,
          show_thinking: showThinking ? 1 : 0,
          auto_start: autoStart ? 1 : 0,
        });
        log.print(`✅ 已保存 ${channel} 应用: ${appName.trim()}`);
      }
    }
  } else if (channel === 'telegram') {
    appId = undefined;
    targetId = identifier;
  } else {
    log.print(`❌ 不支持的渠道: ${channel}`);
    return;
  }

  const result = saveAssignment(agentName, channel, appId, targetId);
  if (!result.success) {
    log.print(`❌ ${result.error}`);
    return;
  }

  const target = appId || targetId || '(渠道默认)';
  log.print(`✅ 已绑定: ${channel}/${target} → ${agentName}`);
}

function unassignAgent(args: string): void {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 1) {
    log.print('用法:');
    log.print('  agent unassign feishu <app_id>');
    log.print('  agent unassign telegram [user_id]');
    log.print('  agent unassign wework [bot_id]');
    return;
  }

  const [channel, identifier] = parts;

  let appId: string | undefined;
  let targetId: string | undefined;

  if (channel === 'feishu') {
    if (!identifier) {
      log.print('❌ 飞书渠道需要指定 app_id');
      return;
    }
    appId = identifier;
  } else if (channel === 'telegram') {
    targetId = identifier;
  } else if (channel === 'wework') {
    appId = identifier;
  }

  const result = deleteAssignment(channel, appId, targetId);
  if (!result.success) {
    log.print(`❌ ${result.error}`);
    return;
  }

  const target = appId || targetId || '(渠道默认)';
  log.print(`✅ 已移除绑定: ${channel}/${target}`);
}

function listAssignmentsCmd(): void {
  const assignments = listAssignments();
  if (assignments.length === 0) {
    log.print('暂无 Agent 绑定');
    return;
  }

  const head = ['渠道', 'App ID', 'App 名称', '自动启动', '目标', 'Agent', '创建时间'];
  const rows = assignments.map(a => [
    a.channel,
    a.appId || '-',
    a.appName || '-',
    a.autoStart === null ? '-' : (a.autoStart ? '✅' : '❌'),
    a.targetId || '-',
    `${a.agentDisplayName} (${a.agentName})`,
    a.createdAt,
  ]);

  renderTable(head, rows);
  log.print(`共 ${assignments.length} 条绑定`);
}

function manageBotApp(args: string): void {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0];
  const id = parts[1];

  if (sub === 'list' || !sub) {
    const channelFilter = parts[1];
    const sql = channelFilter
      ? 'SELECT id, channel, name, auto_start FROM bot_apps WHERE channel = ? ORDER BY channel, name'
      : 'SELECT id, channel, name, auto_start FROM bot_apps ORDER BY channel, name';
    const rows = channelFilter
      ? getDb().prepare(sql).all(channelFilter) as { id: string; channel: string; name: string; auto_start: number }[]
      : getDb().prepare(sql).all() as { id: string; channel: string; name: string; auto_start: number }[];
    if (rows.length === 0) { log.print('暂无 Bot 应用'); return; }
    renderTable(['ID', '渠道', '名称', '自动启动'], rows.map(r => [r.id, r.channel, r.name, r.auto_start ? '✅' : '❌']));
    return;
  }

  if ((sub === 'enable' || sub === 'disable' || sub === 'start' || sub === 'stop') && id) {
    const isEnable = sub === 'enable' || sub === 'start';
    const val = isEnable ? 1 : 0;
    const result = getDb().prepare('UPDATE bot_apps SET auto_start = ? WHERE id = ?').run(val, id);
    if (result.changes === 0) { log.print(`❌ 未找到: ${id}`); return; }
    log.print(`✅ ${id} 已${isEnable ? '开启' : '关闭'}`);
    log.print(`   (服务每 10s 同步一次状态，请稍候)`);
    return;
  }

  log.print('用法:');
  log.print('  agent bot-app list [channel]');
  log.print('  agent bot-app start <id>');
  log.print('  agent bot-app stop <id>');
}
