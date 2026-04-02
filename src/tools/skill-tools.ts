import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { getCurrentAgent } from '../llm/agents/config.js';
import { getAllSkills, getSkillByName, saveSkill, deleteSkill } from '../commands/skill.js';
import { recordEvent } from '../models/event.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'list_skills',
    description: '列出所有已保存的 skill（可复用的能力模板）',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_skill',
    description: '获取某个 skill 的完整内容（名称、描述和完整 prompt）',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'skill 名称' },
      },
      required: ['name'],
    },
  },
  {
    name: 'save_skill',
    description: '创建或更新一个 skill。skill 是教会 LLM 如何处理特定场景的能力说明文档，支持 {param} 占位符。可指定 scope 为当前 Agent 专属',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'skill 名称' },
        description: { type: 'string', description: '一句话说明何时使用这个 skill（用于 system prompt 展示）' },
        prompt: { type: 'string', description: 'skill 的完整内容，建议包含：何时使用、执行步骤、输出格式。支持 {param} 占位符' },
        scope: { type: 'string', description: "'global'（全局，所有 Agent 可用）或 'agent'（仅当前 Agent 可用）。默认 global" },
      },
      required: ['name', 'prompt'],
    },
  },
  {
    name: 'delete_skill',
    description: '删除一个已有的 skill',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: '要删除的 skill 名称' },
      },
      required: ['name'],
    },
  },
  {
    name: 'run_skill',
    description: '执行一个已保存的 skill。当判断当前场景匹配某个 skill 时主动调用，传入所需参数。',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'skill 名称' },
        params: {
          type: 'object' as const,
          description: '传入 skill 的参数（key-value），用于替换 skill 内容中的 {param} 占位符',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['name'],
    },
  },
];

function handleListSkills(): string {
  const agentId = getCurrentAgent()?.id;
  const skills = getAllSkills(agentId);
  return JSON.stringify(skills.map(s => ({
    name: s.name,
    description: s.description,
    params: [...s.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]),
    agent_id: s.agent_id,
  })));
}

function handleGetSkill(input: { name: string }): string {
  const agentId = getCurrentAgent()?.id;
  const skill = getSkillByName(input.name, agentId);
  if (!skill) return JSON.stringify({ error: `未找到 skill: ${input.name}` });
  return JSON.stringify({
    name: skill.name,
    description: skill.description,
    prompt: skill.prompt,
    params: [...skill.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]),
    agent_id: skill.agent_id,
  });
}

function handleSaveSkill(input: { name: string; prompt: string; description?: string; scope?: string }): string {
  const agentId = input.scope === 'agent' ? getCurrentAgent()?.id ?? undefined : undefined;
  return JSON.stringify(saveSkill(input.name, input.prompt, agentId, input.description));
}

function handleDeleteSkill(input: { name: string }): string {
  const agentId = getCurrentAgent()?.id;
  return JSON.stringify(deleteSkill(input.name, agentId));
}

function handleRunSkill(input: { name: string; params?: Record<string, string> }): string {
  const agentId = getCurrentAgent()?.id;
  const skill = getSkillByName(input.name, agentId);
  if (!skill) return JSON.stringify({ error: `未找到 skill: ${input.name}` });

  const params = input.params ?? {};
  const resolved = skill.prompt.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? `{${key}}`);

  const unresolved = [...resolved.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  if (unresolved.length > 0) {
    return JSON.stringify({ error: `缺少参数: ${unresolved.join(', ')}` });
  }

  recordEvent('skill', skill.id, 'run', { name: input.name, params });
  return JSON.stringify({ resolved_prompt: resolved, skill: input.name });
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'list_skills':  return handleListSkills();
    case 'get_skill':    return handleGetSkill(input);
    case 'save_skill':   return handleSaveSkill(input);
    case 'delete_skill': return handleDeleteSkill(input);
    case 'run_skill':    return handleRunSkill(input);
    default:             return null;
  }
}
