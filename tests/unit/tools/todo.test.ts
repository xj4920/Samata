import { describe, it, expect } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('todo tools', () => {
  useUnitDb();

  async function getAgentId(name: string): Promise<string> {
    const { getAgent } = await import('../../../src/llm/agents/config.js');
    return getAgent(name).id;
  }

  describe('createTodo / listTodos / updateTodo / deleteTodo', () => {
    it('creates a todo and lists it', async () => {
      const { createTodo, listTodos } = await import('../../../src/commands/todo.js');
      const agentId = await getAgentId('alter-ego');

      const result = createTodo({ title: '测试待办' }, agentId, 'test-user');
      expect(result.success).toBe(true);
      expect(result.todo.title).toBe('测试待办');
      expect(result.todo.status).toBe('pending');
      expect(result.todo.priority).toBe('normal');

      const list = listTodos({}, agentId, 'test-user');
      expect(list.length).toBe(1);
      expect(list[0].title).toBe('测试待办');
    });

    it('creates todo with all fields', async () => {
      const { createTodo, listTodos } = await import('../../../src/commands/todo.js');
      const agentId = await getAgentId('alter-ego');

      const result = createTodo(
        { title: '详细待办', description: '描述内容', priority: 'high', due_date: '2026-06-01', tags: ['work', 'urgent'] },
        agentId,
        'test-user',
      );
      expect(result.success).toBe(true);
      expect(result.todo.priority).toBe('high');
      expect(result.todo.due_date).toBe('2026-06-01');
      expect(result.todo.tags).toEqual(['work', 'urgent']);

      const list = listTodos({ priority: 'high' }, agentId, 'test-user');
      expect(list.length).toBe(1);
    });

    it('updates todo status', async () => {
      const { createTodo, updateTodo, listTodos } = await import('../../../src/commands/todo.js');
      const agentId = await getAgentId('alter-ego');

      const { todo } = createTodo({ title: '等待更新' }, agentId, 'test-user');
      const updated = updateTodo({ id: todo.id, status: 'done' }, agentId, 'test-user');
      expect(updated.success).toBe(true);
      expect(updated.todo!.status).toBe('done');

      const list = listTodos({ status: 'done' }, agentId, 'test-user');
      expect(list.length).toBe(1);
    });

    it('deletes a todo', async () => {
      const { createTodo, deleteTodo, listTodos } = await import('../../../src/commands/todo.js');
      const agentId = await getAgentId('alter-ego');

      const { todo } = createTodo({ title: '即将删除' }, agentId, 'test-user');
      const result = deleteTodo(todo.id, agentId, 'test-user');
      expect(result.success).toBe(true);

      const list = listTodos({}, agentId, 'test-user');
      expect(list.length).toBe(0);
    });
  });

  describe('tool handler (handleTool)', () => {
    it('create_todo via tool handler returns JSON', async () => {
      const todoTools = await import('../../../src/tools/todo-tools.js');
      const agentId = await getAgentId('alter-ego');

      const result = await withContext({ agentName: 'alter-ego' }, () =>
        todoTools.handleTool('create_todo', { title: '工具层测试' }),
      );
      expect(result).toBeTruthy();
      const parsed = JSON.parse(result!);
      expect(parsed.success).toBe(true);
      expect(parsed.title).toBe('工具层测试');
    });

    it('list_todos via tool handler returns array JSON', async () => {
      const todoTools = await import('../../../src/tools/todo-tools.js');
      const { createTodo } = await import('../../../src/commands/todo.js');
      const agentId = await getAgentId('alter-ego');

      createTodo({ title: 'A' }, agentId, 'test-user');
      createTodo({ title: 'B' }, agentId, 'test-user');

      const result = await withContext({ agentName: 'alter-ego' }, () =>
        todoTools.handleTool('list_todos', {}),
      );
      expect(result).toBeTruthy();
      const parsed = JSON.parse(result!);
      expect(parsed.length).toBe(2);
    });

    it('unknown tool returns null', async () => {
      const todoTools = await import('../../../src/tools/todo-tools.js');
      const result = await todoTools.handleTool('nonexistent_tool', {});
      expect(result).toBeNull();
    });
  });
});
