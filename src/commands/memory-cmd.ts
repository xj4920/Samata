import { listAllMemory, saveMemory, deleteMemory, searchMemory, type MemoryItem } from '../llm/agents/memory.js';
import { getCurrentAgent } from '../llm/agent.js';
import { log } from '../utils/logger.js';
import { renderTable } from '../utils/table.js';

export function handleMemory(args: string): void {
  const match = args.match(/^(\S+)\s*(.*)/s);
  if (!match) {
    showHelp();
    return;
  }

  const sub = match[1].toLowerCase();
  const rest = match[2].trim();

  switch (sub) {
    case 'list': return listMemory();
    case 'add': return addMemory(rest);
    case 'search': return searchMem(rest);
    case 'del':
    case 'delete': return delMemory(rest);
    default:
      showHelp();
  }
}

function showHelp(): void {
  log.print('Memory 用法：');
  log.print('  memory list                              列出所有记忆');
  log.print('  memory add <内容> [--scope=agent] [--cat=fact]  添加记忆');
  log.print('  memory search <关键词>                    搜索记忆');
  log.print('  memory del <id>                          删除记忆');
}

function listMemory(): void {
  const items = listAllMemory();
  if (items.length === 0) {
    log.print('暂无已保存的记忆');
    return;
  }

  const head = ['ID', '范围', 'Agent', '分类', '内容', '来源', '时间'];
  const rows = items.map(m => [
    m.id.slice(0, 8),
    m.scope,
    m.agentId ? m.agentId.replace('agent-', '') : '-',
    m.category ?? '-',
    m.content.length > 40 ? m.content.slice(0, 37) + '...' : m.content,
    m.source,
    m.createdAt ?? '-',
  ]);

  renderTable(head, rows);
  log.print(`共 ${items.length} 条记忆`);
}

function addMemory(args: string): void {
  if (!args) {
    log.print('用法: memory add <内容> [--scope=agent] [--cat=fact]');
    return;
  }

  let scope: 'global' | 'agent' = 'global';
  let category: string | undefined;
  let content = args;

  // Parse flags
  const scopeMatch = content.match(/--scope=(\S+)/);
  if (scopeMatch) {
    scope = scopeMatch[1] as 'global' | 'agent';
    content = content.replace(scopeMatch[0], '').trim();
  }

  const catMatch = content.match(/--cat=(\S+)/);
  if (catMatch) {
    category = catMatch[1];
    content = content.replace(catMatch[0], '').trim();
  }

  if (!content) {
    log.print('记忆内容不能为空');
    return;
  }

  const currentAgentId = getCurrentAgent()?.id;
  const result = saveMemory({
    content,
    scope,
    agentId: scope === 'agent' ? currentAgentId ?? undefined : undefined,
    category,
    source: 'manual',
  });

  if (!result.success) {
    log.print((result as any).error);
    return;
  }
  log.print(`记忆已保存 (${scope}): ${content}`);
}

function searchMem(keyword: string): void {
  if (!keyword) {
    log.print('用法: memory search <关键词>');
    return;
  }

  const currentAgentId = getCurrentAgent()?.id;
  const items = searchMemory(keyword, currentAgentId ?? undefined);

  if (items.length === 0) {
    log.print(`未找到匹配的记忆: ${keyword}`);
    return;
  }

  const head = ['ID', '范围', '内容', '时间'];
  const rows = items.map(m => [
    m.id.slice(0, 8),
    m.scope,
    m.content.length > 60 ? m.content.slice(0, 57) + '...' : m.content,
    m.createdAt ?? '-',
  ]);

  renderTable(head, rows);
  log.print(`找到 ${items.length} 条记忆`);
}

function delMemory(idPrefix: string): void {
  if (!idPrefix) {
    log.print('用法: memory del <id>');
    return;
  }
  const result = deleteMemory(idPrefix);
  if (!result.success) {
    log.print((result as any).error);
    return;
  }
  log.print(`记忆已删除: ${idPrefix}`);
}
