import { getExecutionChannel } from '../../runtime/execution-context.js';
import { getAllAgents, saveAgent, type AgentConfig } from './config.js';

export interface AgentToolBindingInput {
  agentName: string;
  addTools?: string[];
  removeTools?: string[];
  blockTools?: string[];
  unblockTools?: string[];
  memberBlockTools?: string[];
  memberUnblockTools?: string[];
  dryRun?: boolean;
}

export interface AgentToolBindingSnapshot {
  toolsList: string[];
  blockTools: string[];
  userToolsMode: AgentConfig['userToolsMode'];
  userToolsList: string[];
}

export type AgentToolBindingResult =
  | {
      success: true;
      agentName: string;
      changed: boolean;
      dryRun: boolean;
      before: AgentToolBindingSnapshot;
      after: AgentToolBindingSnapshot;
      added: {
        toolsList: string[];
        blockTools: string[];
        userToolsList: string[];
      };
      removed: {
        toolsList: string[];
        blockTools: string[];
        userToolsList: string[];
      };
    }
  | { success: false; error: string };

function normalizeTools(tools: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tools ?? []) {
    const tool = raw.trim();
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    result.push(tool);
  }
  return result;
}

function snapshot(agent: AgentConfig): AgentToolBindingSnapshot {
  return {
    toolsList: normalizeTools(agent.toolsList),
    blockTools: normalizeTools(agent.blockTools),
    userToolsMode: agent.userToolsMode,
    userToolsList: normalizeTools(agent.userToolsList),
  };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameSnapshot(a: AgentToolBindingSnapshot, b: AgentToolBindingSnapshot): boolean {
  return a.userToolsMode === b.userToolsMode
    && sameList(a.toolsList, b.toolsList)
    && sameList(a.blockTools, b.blockTools)
    && sameList(a.userToolsList, b.userToolsList);
}

function removeTools(current: string[], requested: string[]): { next: string[]; removed: string[] } {
  const removeSet = new Set(requested);
  const removed = current.filter(tool => removeSet.has(tool));
  return {
    next: current.filter(tool => !removeSet.has(tool)),
    removed,
  };
}

function addTools(current: string[], requested: string[]): { next: string[]; added: string[] } {
  const next = [...current];
  const present = new Set(next);
  const added: string[] = [];
  for (const tool of requested) {
    if (present.has(tool)) continue;
    next.push(tool);
    present.add(tool);
    added.push(tool);
  }
  return { next, added };
}

export function applyAgentToolBinding(input: AgentToolBindingInput): AgentToolBindingResult {
  if (getExecutionChannel() !== 'cli') {
    return { success: false, error: '权限不足：Agent 工具绑定仅支持 CLI channel' };
  }

  const agentName = input.agentName.trim();
  if (!agentName) return { success: false, error: 'agentName 不能为空' };

  const agent = getAllAgents().find(item => item.name === agentName);
  if (!agent) return { success: false, error: `未找到 Agent: ${agentName}` };

  const before = snapshot(agent);
  const after: AgentToolBindingSnapshot = {
    toolsList: [...before.toolsList],
    blockTools: [...before.blockTools],
    userToolsMode: before.userToolsMode,
    userToolsList: [...before.userToolsList],
  };
  const added = { toolsList: [] as string[], blockTools: [] as string[], userToolsList: [] as string[] };
  const removed = { toolsList: [] as string[], blockTools: [] as string[], userToolsList: [] as string[] };

  const toolsRemoved = removeTools(after.toolsList, normalizeTools(input.removeTools));
  after.toolsList = toolsRemoved.next;
  removed.toolsList = toolsRemoved.removed;
  const toolsAdded = addTools(after.toolsList, normalizeTools(input.addTools));
  after.toolsList = toolsAdded.next;
  added.toolsList = toolsAdded.added;

  const blocksRemoved = removeTools(after.blockTools, normalizeTools(input.unblockTools));
  after.blockTools = blocksRemoved.next;
  removed.blockTools = blocksRemoved.removed;
  const blocksAdded = addTools(after.blockTools, normalizeTools(input.blockTools));
  after.blockTools = blocksAdded.next;
  added.blockTools = blocksAdded.added;

  const memberRemoved = removeTools(after.userToolsList, normalizeTools(input.memberUnblockTools));
  after.userToolsList = memberRemoved.next;
  removed.userToolsList = memberRemoved.removed;
  const memberAdded = addTools(after.userToolsList, normalizeTools(input.memberBlockTools));
  after.userToolsList = memberAdded.next;
  added.userToolsList = memberAdded.added;
  if (normalizeTools(input.memberBlockTools).length > 0 && after.userToolsMode !== 'blocklist') {
    after.userToolsMode = 'blocklist';
  }

  const changed = !sameSnapshot(before, after);
  const dryRun = input.dryRun === true;
  if (!changed || dryRun) {
    return { success: true, agentName, changed, dryRun, before, after, added, removed };
  }

  const result = saveAgent({
    name: agent.name,
    displayName: agent.displayName,
    description: agent.description,
    model: agent.model,
    provider: agent.provider,
    toolsMode: agent.toolsMode,
    toolsList: after.toolsList,
    blockTools: after.blockTools,
    preset: agent.preset,
    userToolsMode: after.userToolsMode,
    userToolsList: after.userToolsList,
    maxHistory: agent.maxHistory,
  });
  if (!result.success) return result;

  return { success: true, agentName, changed, dryRun, before, after, added, removed };
}
