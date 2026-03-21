import { getAllAgents, getAgent, saveAgent, deleteAgent, manageAgentMember, getAgentTools, saveAssignment, deleteAssignment, listAssignments, getFeishuApp, saveFeishuApp, type AgentConfig, TOOL_PRESETS } from '../llm/agents/config.js';
import { setCurrentAgent, getCurrentAgent, resetConversation, getGlobalTools } from '../llm/agent.js';
import { log } from '../utils/logger.js';
import { renderTable } from '../utils/table.js';
import { input, select, confirm } from '@inquirer/prompts';
import { getDb } from '../db/connection.js';

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
    case 'create': return createAgent();
    case 'member': return manageMembers(rest);
    case 'del':
    case 'delete': return delAgent(rest);
    case 'assign': return assignAgent(rest);
    case 'unassign': return unassignAgent(rest);
    case 'assignments': return listAssignmentsCmd();
    case 'feishu-app': return manageFeishuApp(rest);
    default:
      // Treat unknown sub as agent name to switch to
      return switchAgent(sub);
  }
}

function showHelp(): void {
  log.print('Agent 用法：');
  log.print('  agent list                  列出所有 Agent');
  log.print('  agent create                创建新 Agent（交互向导）');
  log.print('  agent switch <name>         切换当前会话的 Agent');
  log.print('  agent info                  查看当前 Agent 信息');
  log.print('  agent member <add|del> <agent_name> <username> [role]  管理 Agent 成员 (默认 admin)');
  log.print('  agent del <name>            删除 Agent');
  log.print('  agent assign <name> feishu <app_id>        绑定 Agent 到飞书应用');
  log.print('  agent assign <name> telegram [user_id]     绑定 Agent 到 Telegram 用户');
  log.print('  agent unassign feishu <app_id>             移除飞书应用绑定');
  log.print('  agent unassign telegram [user_id]          移除 Telegram 用户绑定');
  log.print('  agent assignments                          列出所有绑定');
  log.print('  agent feishu-app list                      列出飞书应用及自动启动状态');
  log.print('  agent feishu-app enable <app_id>           开���自动启动');
  log.print('  agent feishu-app disable <app_id>          关闭自动启动');
}

async function createAgent(): Promise<void> {
  log.print('=== 创建新 Agent ===');

  // Step 1: Basic info
  const name = await input({
    message: 'Agent 名称（英文，唯一）:',
    validate: (v) => {
      if (!v.trim()) return '名称不能为空';
      if (!/^[a-z0-9-]+$/.test(v.trim())) return '只允许小写字母、数字和连字符';
      const existing = getAllAgents().find(a => a.name === v.trim());
      if (existing) return `名称已存在: ${v.trim()}`;
      return true;
    },
  });

  const displayName = await input({
    message: '显示名称:',
    validate: (v) => v.trim() ? true : '显示名称不能为空',
  });

  const description = await input({ message: '描述（可选）:' });

  // Step 2: Tools config
  const toolsModeChoice = await select({
    message: '工具配置方式:',
    choices: [
      { name: '全部工具（all）', value: 'all' },
      { name: '使用预设（preset）', value: 'preset' },
      { name: '自定义工具列表', value: 'custom' },
      { name: '黑名单模式（blocklist）', value: 'blocklist' },
    ],
  });

  let toolsMode: 'all' | 'allowlist' | 'blocklist' = 'all';
  let toolsList: string[] | undefined;

  if (toolsModeChoice === 'preset') {
    const presetChoices = Object.entries(TOOL_PRESETS).map(([key, p]) => ({
      name: `${key} — ${p.description} (${p.tools.length} 个工具)`,
      value: key,
    }));
    const presetKey = await select({ message: '选择预设:', choices: presetChoices });
    toolsMode = 'allowlist';
    toolsList = TOOL_PRESETS[presetKey].tools;
    log.print(`  已选预设 ${presetKey}，包含 ${toolsList.length} 个工具`);
  } else if (toolsModeChoice === 'custom') {
    const globalTools = getGlobalTools();
    log.print(`  可用工具: ${globalTools.map(t => t.name).join(', ')}`);
    const toolsInput = await input({
      message: '输入工具名称（逗号分隔）:',
      validate: (v) => v.trim() ? true : '至少输入一个工具名',
    });
    toolsMode = 'allowlist';
    toolsList = toolsInput.split(',').map(t => t.trim()).filter(Boolean);
  } else if (toolsModeChoice === 'blocklist') {
    const globalTools = getGlobalTools();
    log.print(`  可用工具: ${globalTools.map(t => t.name).join(', ')}`);
    const toolsInput = await input({ message: '输入要排除的工具名称（逗号分隔，可留空）:' });
    toolsMode = 'blocklist';
    toolsList = toolsInput ? toolsInput.split(',').map(t => t.trim()).filter(Boolean) : [];
  }

  // Step 3: System prompt (optional)
  const systemPrompt = await input({ message: '系统提示词（可选，留空使用默认）:' });

  // Step 4: Model/Provider (optional)
  const model = await input({ message: '模型（可选，留空使用全局默认）:' });
  const provider = await input({ message: 'Provider（可选，留空使用全局默认）:' });

  // Step 5: Confirm
  log.print('\n=== 确认信息 ===');
  log.print(`  名称: ${name}`);
  log.print(`  显示名: ${displayName}`);
  if (description) log.print(`  描述: ${description}`);
  log.print(`  工具模式: ${toolsMode}${toolsList ? ` (${toolsList.length} 个)` : ''}`);
  if (systemPrompt) log.print(`  系统提示词: ${systemPrompt.slice(0, 50)}...`);
  if (model) log.print(`  模型: ${model}`);
  if (provider) log.print(`  Provider: ${provider}`);

  const ok = await confirm({ message: '确认创建？', default: true });
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
  });

  if (!result.success) {
    log.print(`创建失败: ${(result as any).error}`);
    return;
  }
  log.print(`Agent 已创建: ${displayName} (${name})`);
}

function manageMembers(args: string): void {
    const parts = args.split(/\s+/);
    if (parts.length < 3) {
        log.print('用法: agent member <add|del> <agent_name> <username> [role]');
        return;
    }
    
    const [action, agentName, username, roleInput] = parts;
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
      a.toolsMode === 'all' ? `全部 (${availableTools.length})` : `${a.toolsMode} (${availableTools.length})`,
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
    return;
  }

  const [agentName, channel, identifier] = parts;

  let appId: string | undefined;
  let targetId: string | undefined;

  if (channel === 'feishu') {
    if (!identifier) {
      log.print('❌ 飞书渠道需要指定 app_id');
      return;
    }
    appId = identifier;

    // 若 feishu_apps 中不存在该 app_id，引导填写
    const existing = getFeishuApp(appId);
    if (!existing) {
      log.print(`⚠️  app_id "${appId}" 不在 feishu_apps 中，请填写应用信息：`);
      const appName = await input({ message: 'App 名称:', validate: (v) => v.trim() ? true : '不能为空' });
      const appSecret = await input({ message: 'App Secret:', validate: (v) => v.trim() ? true : '不能为空' });
      const verificationToken = await input({ message: 'Verification Token（可选）:', default: '' });
      const encryptKey = await input({ message: 'Encrypt Key（可选）:', default: '' });
      const showThinking = await confirm({ message: '显示思考过程?', default: true });
      const autoStart = await confirm({ message: '启动时自动启动此 Bot?', default: true });
      saveFeishuApp({
        app_id: appId,
        app_name: appName.trim(),
        app_secret: appSecret.trim(),
        verification_token: verificationToken.trim(),
        encrypt_key: encryptKey.trim(),
        show_thinking: showThinking ? 1 : 0,
        auto_start: autoStart ? 1 : 0,
      });
      log.print(`✅ 已保存飞书应用: ${appName.trim()}`);
    }
  } else if (channel === 'telegram') {
    appId = undefined;
    targetId = identifier;  // 可选
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

function manageFeishuApp(args: string): void {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0];
  const appId = parts[1];

  if (sub === 'list' || !sub) {
    const rows = getDb().prepare('SELECT app_id, app_name, auto_start FROM feishu_apps ORDER BY app_name').all() as { app_id: string; app_name: string; auto_start: number }[];
    if (rows.length === 0) { log.print('暂无飞书应用'); return; }
    renderTable(['App ID', '名称', '自动启动'], rows.map(r => [r.app_id, r.app_name, r.auto_start ? '✅' : '❌']));
    return;
  }

  if ((sub === 'enable' || sub === 'disable' || sub === 'start' || sub === 'stop') && appId) {
    const isEnable = sub === 'enable' || sub === 'start';
    const val = isEnable ? 1 : 0;
    const result = getDb().prepare('UPDATE feishu_apps SET auto_start = ? WHERE app_id = ?').run(val, appId);
    if (result.changes === 0) { log.print(`❌ 未找到 app_id: ${appId}`); return; }
    log.print(`✅ ${appId} 已${isEnable ? '开启/启动' : '关闭/停止'}`);
    log.print(`   (飞书服务每 10s 同步一次状态，请稍候)`);
    return;
  }

  log.print('用法:');
  log.print('  agent feishu-app list');
  log.print('  agent feishu-app start <app_id>');
  log.print('  agent feishu-app stop <app_id>');
  log.print('  agent feishu-app enable <app_id>');
  log.print('  agent feishu-app disable <app_id>');
}
