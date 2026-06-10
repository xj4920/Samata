import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { CreateTodoInput, ListTodosInput, UpdateTodoInput, DeleteTodoInput } from '../llm/tool-types.js';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { getCurrentUser } from '../auth/rbac.js';
import { createTodo, listTodos, updateTodo, deleteTodo } from '../commands/todo.js';

const DEFAULT_TAGS = ['工作', '个人', '学习', '生活', '孩子', '紧急', '健康'];

function loadTodoTags(): string[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const cfgPath = resolve(root, 'config/monitor.json');
  if (!existsSync(cfgPath)) return DEFAULT_TAGS;
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf-8')).todos?.tags ?? DEFAULT_TAGS;
  } catch { return DEFAULT_TAGS; }
}

const TODO_TAGS = loadTodoTags();

function getTodoReadAgentId(): string | undefined {
  const agent = getCurrentAgent();
  // Admin has a platform view; business agents remain scoped to their own todos.
  return agent?.name === 'admin' ? undefined : agent?.id;
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'create_todo',
    description: '创建一个新的待办事项（todo）',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: '待办事项标题' },
        description: { type: 'string', description: '详细描述（可选）' },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: '优先级：low（低）、normal（普通）、high（高），默认 normal',
        },
        due_date: { type: 'string', description: '截止日期，格式 YYYY-MM-DD（可选）' },
        tags: {
          type: 'array',
          items: { type: 'string', enum: TODO_TAGS },
          description: '标签列表（可选）',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_todos',
    description: '列出待办事项。默认只显示未完成的（pending + in_progress），可指定 status=all 查看全部',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done', 'all'],
          description: '筛选状态：pending（待处理）、in_progress（进行中）、done（已完成）、all（全部），默认显示未完成',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: '按优先级筛选（可选）',
        },
      },
      required: [],
    },
  },
  {
    name: 'update_todo',
    description: '更新待办事项，可修改标题、描述、状态、优先级或截止日期。用 status=done 来标记完成',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo ID 或 ID 前缀（通过 list_todos 获取）' },
        title: { type: 'string', description: '新标题（可选）' },
        description: { type: 'string', description: '新描述（可选）' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done'],
          description: '新状态（可选）',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: '新优先级（可选）',
        },
        due_date: { type: 'string', description: '新截止日期 YYYY-MM-DD，传空字符串清除（可选）' },
        tags: {
          type: 'array',
          items: { type: 'string', enum: TODO_TAGS },
          description: '新标签列表，传空数组 [] 清除（可选）',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_todo',
    description: '删除一个待办事项',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Todo ID 或 ID 前缀（通过 list_todos 获取）' },
      },
      required: ['id'],
    },
  },
];

function handleCreateTodo(input: CreateTodoInput): string {
  const agentId = getCurrentAgent()?.id;
  const userId = getCurrentUser()?.id;
  const result = createTodo(input, agentId, userId);
  return JSON.stringify({
    success: result.success,
    id: result.id,
    title: result.todo.title,
    status: result.todo.status,
    priority: result.todo.priority,
    due_date: result.todo.due_date,
    tags: result.todo.tags,
  });
}

function handleListTodos(input: ListTodosInput): string {
  const agentId = getTodoReadAgentId();
  const userId = getCurrentUser()?.id;
  const items = listTodos(input, agentId, userId);
  if (items.length === 0) return JSON.stringify({ message: '暂无待办事项' });
  return JSON.stringify(items.map(t => ({
    id: t.id.slice(0, 8),
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    due_date: t.due_date,
    tags: t.tags,
  })));
}

function handleUpdateTodo(input: UpdateTodoInput): string {
  const agentId = getTodoReadAgentId();
  const userId = getCurrentUser()?.id;
  const result = updateTodo(input, agentId, userId);
  if (!result.success) return JSON.stringify(result);
  return JSON.stringify({
    success: true,
    id: result.todo!.id.slice(0, 8),
    title: result.todo!.title,
    status: result.todo!.status,
    priority: result.todo!.priority,
    due_date: result.todo!.due_date,
    tags: result.todo!.tags,
  });
}

function handleDeleteTodo(input: DeleteTodoInput): string {
  const agentId = getTodoReadAgentId();
  const userId = getCurrentUser()?.id;
  return JSON.stringify(deleteTodo(input.id, agentId, userId));
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'create_todo': return handleCreateTodo(input);
    case 'list_todos': return handleListTodos(input);
    case 'update_todo': return handleUpdateTodo(input);
    case 'delete_todo': return handleDeleteTodo(input);
    default: return null;
  }
}
