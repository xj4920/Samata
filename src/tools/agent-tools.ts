import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { getCurrentAgent, setCurrentAgent, getAllAgents, getAgent, saveAgent, deleteAgent, manageAgentMember, listAgentMembers, saveAssignment, deleteAssignment, listAssignments, TOOL_PRESETS, COMMON_SET, getAgentTools } from '../llm/agents/config.js';
import { getExecutionChannel } from '../runtime/execution-context.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'list_agents',
    description: '列出所有可用的 Agent',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_agent',
    description: '查看某个 Agent 的详细配置。不传 name 则返回当前会话使用的 Agent。',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Agent 名称（不传则返回当前 Agent）' } },
      required: [],
    },
  },
  {
    name: 'manage_agent_member',
    description: '管理 Agent 成员及其角色（仅管理员）。支持添加或删除成员。',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['add', 'del'], description: '操作：add (添加) 或 del (删除)' },
        agent_name: { type: 'string', description: 'Agent 名称' },
        username: { type: 'string', description: '系统内用户名 (通常为 feishu_ou_xxx 或 user_xxxxxx)' },
        role: { type: 'string', enum: ['admin', 'user'], description: '角色：admin (管理员) 或 user (普通成员)，默认为 admin' },
      },
      required: ['action', 'agent_name', 'username'],
    },
  },
  {
    name: 'list_agent_members',
    description: '列出某个 Agent 的所有成员',
    input_schema: {
      type: 'object' as const,
      properties: { agent_name: { type: 'string', description: 'Agent 名称' } },
      required: ['agent_name'],
    },
  },
  {
    name: 'save_agent',
    description: '创建或更新 Agent（仅管理员）。standard 模式下有效工具 = COMMON_SET + tools_list - block_tools。',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Agent 唯一名称（英文）' },
        display_name: { type: 'string', description: 'Agent 显示名称' },
        description: { type: 'string', description: 'Agent 职责描述' },
        system_prompt: { type: 'string', description: '自定义 system prompt（不传则使用默认）' },
        model: { type: 'string', description: '指定模型（不传则使用全局默认）' },
        provider: { type: 'string', description: '指定 provider（不传则使用全局默认）' },
        tools_mode: { type: 'string', description: "'all' | 'standard'。standard 模式: COMMON_SET + tools_list - block_tools" },
        tools_list: { type: 'array', items: { type: 'string' }, description: 'standard 模式下在 COMMON_SET 之外额外允许的工具' },
        block_tools: { type: 'array', items: { type: 'string' }, description: 'standard 模式下从 COMMON_SET 中排除的工具' },
        max_history: { type: 'number', description: '最大历史消息数，默认 80' },
        preset: { type: 'string', description: "工具预设名称（'common' | 'browser'），用于快速填充 tools_list" },
        user_tools_mode: { type: 'string', description: "普通成员工具模式: 'inherit'（与 admin 一致）| 'allowlist' | 'blocklist'" },
        user_tools_list: { type: 'array', items: { type: 'string' }, description: '普通成员工具名称列表（配合 user_tools_mode 使用）' },
      },
      required: ['name', 'display_name'],
    },
  },
  {
    name: 'delete_agent',
    description: '删除 Agent（仅管理员，不可删除默认 agent）',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Agent 名称' } },
      required: ['name'],
    },
  },
  {
    name: 'switch_agent',
    description: '切换当前会话使用的 Agent。切换后会清空对话历史。',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: '要切换到的 Agent 名称' } },
      required: ['name'],
    },
  },
  {
    name: 'assign_agent',
    description: '将 Agent 绑定到指定渠道或应用。feishu 渠道用 app_id 标识应用，telegram/cli 渠道用 target_id 标识用户。',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent_name: { type: 'string', description: 'Agent 名称' },
        channel: { type: 'string', description: "渠道: 'feishu' | 'telegram' | 'cli'" },
        app_id: { type: 'string', description: 'feishu 渠道专用：飞书 app_id（如 cli_xxx）' },
        target_id: { type: 'string', description: 'telegram/cli 渠道专用：用户 ID' },
      },
      required: ['agent_name', 'channel'],
    },
  },
  {
    name: 'unassign_agent',
    description: '移除 Agent 绑定。feishu 渠道用 app_id，telegram/cli 渠道用 target_id。',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: "渠道: 'feishu' | 'telegram' | 'cli'" },
        app_id: { type: 'string', description: 'feishu 渠道专用：飞书 app_id' },
        target_id: { type: 'string', description: 'telegram/cli 渠道专用：用户 ID' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'list_agent_assignments',
    description: '列出所有 Agent 绑定关系',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

function handleListAgents(globalTools?: Anthropic.Tool[]): string {
  const agents = getAllAgents();
  const tools = globalTools ?? [];
  return JSON.stringify(agents.map(a => {
    const availableTools = getAgentTools(a, tools).map(t => t.name);
    return {
      name: a.name,
      displayName: a.displayName,
      description: a.description,
      toolsMode: a.toolsMode,
      availableToolsCount: availableTools.length,
      availableTools,
    };
  }));
}

function handleGetAgent(input: { name?: string }, globalTools?: Anthropic.Tool[]): string {
  const agent = input.name ? getAgent(input.name) : getCurrentAgent();
  if (!agent) return JSON.stringify({ error: '当前无活跃 Agent' });
  const tools = globalTools ?? [];
  const availableTools = getAgentTools(agent, tools).map(t => t.name);
  return JSON.stringify({
    ...agent,
    availableToolsCount: availableTools.length,
    availableTools,
  });
}

function handleSaveAgent(input: {
  name: string;
  display_name: string;
  description?: string;
  system_prompt?: string;
  model?: string;
  provider?: string;
  tools_mode?: string;
  tools_list?: string[];
  block_tools?: string[];
  max_history?: number;
  preset?: string;
  user_tools_mode?: string;
  user_tools_list?: string[];
}): string {
  if (input.preset) {
    const preset = TOOL_PRESETS[input.preset];
    if (!preset) return JSON.stringify({ error: `未知 preset: ${input.preset}，可用: ${Object.keys(TOOL_PRESETS).join(', ')}` });
    input.tools_mode = input.tools_mode || 'standard';
    // For preset, set tools_list to non-COMMON_SET tools from the preset
    input.tools_list = preset.tools.filter(t => !COMMON_SET.has(t));
  }
  const result = saveAgent({
    name: input.name,
    displayName: input.display_name,
    description: input.description,
    systemPrompt: input.system_prompt,
    model: input.model,
    provider: input.provider,
    toolsMode: input.tools_mode as any,
    toolsList: input.tools_list,
    blockTools: input.block_tools,
    preset: input.preset,
    userToolsMode: input.user_tools_mode as any,
    userToolsList: input.user_tools_list,
    maxHistory: input.max_history,
  });
  return JSON.stringify(result);
}

function handleDeleteAgent(input: { name: string }): string {
  return JSON.stringify(deleteAgent(input.name));
}

function handleSwitchAgent(input: { name: string }): string {
  const agent = getAgent(input.name);
  if (agent.name !== input.name && input.name !== 'otcclaw') {
    return JSON.stringify({ error: `未找到 Agent: ${input.name}` });
  }
  // Only set agent; don't resetConversation() here because we're inside the agentic loop.
  // The conversation history will be cleared on the next chat() call or /reset.
  setCurrentAgent(agent);
  return JSON.stringify({ success: true, message: `已切换到 Agent: ${agent.displayName} (${agent.name})，下次对话将使用新 Agent 配置` });
}

function handleAssignAgent(input: { agent_name: string; channel: string; app_id?: string; target_id?: string }): string {
  const appId = input.channel === 'feishu' ? (input.app_id ?? input.target_id) : undefined;
  const targetId = input.channel !== 'feishu' ? input.target_id : undefined;
  return JSON.stringify(saveAssignment(input.agent_name, input.channel, appId, targetId));
}

function handleUnassignAgent(input: { channel: string; app_id?: string; target_id?: string }): string {
  const appId = input.channel === 'feishu' ? (input.app_id ?? input.target_id) : undefined;
  const targetId = input.channel !== 'feishu' ? input.target_id : undefined;
  return JSON.stringify(deleteAssignment(input.channel, appId, targetId));
}

function handleListAssignments(): string {
  return JSON.stringify(listAssignments());
}

function handleManageAgentMember(input: { action: string; agent_name: string; username: string; role?: string }): string {
  const result = manageAgentMember(input.action as 'add' | 'del', input.agent_name, input.username, (input.role as any) || 'admin');
  return JSON.stringify(result);
}

function handleListAgentMembers(input: { agent_name: string }): string {
  const result = listAgentMembers(input.agent_name);
  return JSON.stringify(result);
}

export async function handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'list_agents': case 'get_agent':
    case 'manage_agent_member': case 'list_agent_members':
    case 'save_agent': case 'delete_agent': case 'switch_agent':
    case 'assign_agent': case 'unassign_agent': case 'list_agent_assignments':
      break;
    default: return null;
  }

  if (getExecutionChannel() !== 'cli') {
    return JSON.stringify({ error: '权限不足：Agent 管理工具仅支持 CLI channel' });
  }

  switch (name) {
    case 'list_agents': return handleListAgents(ctx?.globalTools);
    case 'get_agent': return handleGetAgent(input, ctx?.globalTools);
    case 'manage_agent_member': return handleManageAgentMember(input);
    case 'list_agent_members': return handleListAgentMembers(input);
    case 'save_agent': return handleSaveAgent(input);
    case 'delete_agent': return handleDeleteAgent(input);
    case 'switch_agent': return handleSwitchAgent(input);
    case 'assign_agent': return handleAssignAgent(input);
    case 'unassign_agent': return handleUnassignAgent(input);
    case 'list_agent_assignments': return handleListAssignments();
    default: return null;
  }
}
