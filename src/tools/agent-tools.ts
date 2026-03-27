import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { getCurrentAgent, getAllAgents, getAgent, saveAgent, deleteAgent, saveAssignment, deleteAssignment, listAssignments, TOOL_PRESETS, getAgentTools } from '../llm/agents/config.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'list_agents',
    description: '列出所有可用的 Agent',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_agent',
    description: '查看某个 Agent 的详细配置',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Agent 名称' } },
      required: ['name'],
    },
  },
  {
    name: 'save_agent',
    description: '创建或更新 Agent（仅管理员）。支持 LLM 自举创建新 Agent。',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Agent 唯一名称（英文）' },
        display_name: { type: 'string', description: 'Agent 显示名称' },
        description: { type: 'string', description: 'Agent 职责描述' },
        system_prompt: { type: 'string', description: '自定义 system prompt（不传则使用默认）' },
        model: { type: 'string', description: '指定模型（不传则使用全局默认）' },
        provider: { type: 'string', description: '指定 provider（不传则使用全局默认）' },
        tools_mode: { type: 'string', description: "'all' | 'allowlist' | 'blocklist'" },
        tools_list: { type: 'array', items: { type: 'string' }, description: '工具名称列表（配合 tools_mode 使用）' },
        max_history: { type: 'number', description: '最大历史消息数，默认 80' },
        preset: { type: 'string', description: "工具预设名称（'common' | 'alter_ego' | 'readonly'），设置后自动填充 tools_list，tools_mode 为 allowlist" },
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

function handleGetAgent(input: { name: string }, globalTools?: Anthropic.Tool[]): string {
  const agent = getAgent(input.name);
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
  max_history?: number;
  preset?: string;
}): string {
  if (input.preset) {
    const preset = TOOL_PRESETS[input.preset];
    if (!preset) return JSON.stringify({ error: `未知 preset: ${input.preset}，可用: ${Object.keys(TOOL_PRESETS).join(', ')}` });
    input.tools_mode = input.tools_mode || 'allowlist';
    input.tools_list = preset.tools;
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
    preset: input.preset,
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
  return JSON.stringify({ success: true, message: `已切换到 Agent: ${agent.displayName} (${agent.name})` });
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

export async function handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'list_agents': return handleListAgents(ctx?.globalTools);
    case 'get_agent': return handleGetAgent(input, ctx?.globalTools);
    case 'save_agent': return handleSaveAgent(input);
    case 'delete_agent': return handleDeleteAgent(input);
    case 'switch_agent': return handleSwitchAgent(input);
    case 'assign_agent': return handleAssignAgent(input);
    case 'unassign_agent': return handleUnassignAgent(input);
    case 'list_agent_assignments': return handleListAssignments();
    default: return null;
  }
}
