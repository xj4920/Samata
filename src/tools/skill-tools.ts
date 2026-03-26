import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { getCurrentAgent } from '../llm/agents/config.js';
import { getAllSkills, getSkillByName, saveSkill, deleteSkill } from '../commands/skill.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'list_skills',
    description: '列出所有已保存的 skill（可复用的提示词模板）',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_skill',
    description: '获取某个 skill 的详细信息（名称和 prompt 模板）',
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
    description: '创建或更新一个 skill（可复用的提示词模板），支持 {param} 占位符。可指定 scope 为当前 Agent 专属',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'skill 名称' },
        prompt: { type: 'string', description: 'skill 的 prompt 模板，支持 {param} 占位符' },
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
];

function handleListSkills(): string {
  const agentId = getCurrentAgent()?.id;
  const skills = getAllSkills(agentId);
  return JSON.stringify(skills.map(s => ({
    name: s.name,
    prompt: s.prompt,
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
    prompt: skill.prompt,
    params: [...skill.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]),
    agent_id: skill.agent_id,
  });
}

function handleSaveSkill(input: { name: string; prompt: string; scope?: string }): string {
  const agentId = input.scope === 'agent' ? getCurrentAgent()?.id ?? undefined : undefined;
  return JSON.stringify(saveSkill(input.name, input.prompt, agentId));
}

function handleDeleteSkill(input: { name: string }): string {
  return JSON.stringify(deleteSkill(input.name));
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'list_skills': return handleListSkills();
    case 'get_skill': return handleGetSkill(input);
    case 'save_skill': return handleSaveSkill(input);
    case 'delete_skill': return handleDeleteSkill(input);
    default: return null;
  }
}
