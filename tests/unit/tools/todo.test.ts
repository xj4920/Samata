import { describe, it, expect } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('todo tools', () => {
  const unit = useUnitDb();

  async function getAgentId(name: string): Promise<string> {
    const { getAgent } = await import('../../../src/llm/agents/config.js');
    return getAgent(name).id;
  }

  describe('createTodo / listTodos / updateTodo / deleteTodo', () => {
    it('creates a todo and lists it', async () => {
      const { createTodo, listTodos } = await import('../../../src/commands/todo.js');
      const agentId = await getAgentId('admin');

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
      const agentId = await getAgentId('admin');

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
      const agentId = await getAgentId('admin');

      const { todo } = createTodo({ title: '等待更新' }, agentId, 'test-user');
      const updated = updateTodo({ id: todo.id, status: 'done' }, agentId, 'test-user');
      expect(updated.success).toBe(true);
      expect(updated.todo!.status).toBe('done');

      const list = listTodos({ status: 'done' }, agentId, 'test-user');
      expect(list.length).toBe(1);
    });

    it('filters pending and in_progress separately', async () => {
      const { createTodo, updateTodo, listTodos } = await import('../../../src/commands/todo.js');
      const agentId = await getAgentId('admin');

      createTodo({ title: '只待处理' }, agentId, 'test-user');
      const { todo } = createTodo({ title: '已经开始' }, agentId, 'test-user');
      updateTodo({ id: todo.id, status: 'in_progress' }, agentId, 'test-user');

      const pending = listTodos({ status: 'pending' }, agentId, 'test-user');
      const inProgress = listTodos({ status: 'in_progress' }, agentId, 'test-user');

      expect(pending.map(t => t.title)).toEqual(['只待处理']);
      expect(inProgress.map(t => t.title)).toEqual(['已经开始']);
    });

    it('deletes a todo', async () => {
      const { createTodo, deleteTodo, listTodos } = await import('../../../src/commands/todo.js');
      const agentId = await getAgentId('admin');

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
      const agentId = await getAgentId('admin');

      const result = await withContext({ agentName: 'admin' }, () =>
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
      const agentId = await getAgentId('admin');

      createTodo({ title: 'A' }, agentId, 'test-user');
      createTodo({ title: 'B' }, agentId, 'test-user');

      const result = await withContext({ agentName: 'admin' }, () =>
        todoTools.handleTool('list_todos', {}),
      );
      expect(result).toBeTruthy();
      const parsed = JSON.parse(result!);
      expect(parsed.length).toBe(2);
    });

    it('admin can list and update aliased user todos from another agent', async () => {
      const todoTools = await import('../../../src/tools/todo-tools.js');
      const { createTodo, listTodos } = await import('../../../src/commands/todo.js');
      const { getAgent } = await import('../../../src/llm/agents/config.js');
      const adminId = getAgent('admin').id;
      const learningAgentId = getAgent('learning-test').id;

      unit.db.prepare(
        `INSERT OR IGNORE INTO users (id, username, role) VALUES (?, ?, 'user')`,
      ).run('legacy-user', 'legacy_user');
      unit.db.prepare(
        `INSERT OR IGNORE INTO user_aliases (canonical_user_id, alias_user_id, note) VALUES (?, ?, ?)`,
      ).run('test-user', 'legacy-user', 'test alias');

      const legacy = createTodo({ title: '旧学习待办' }, learningAgentId, 'legacy-user');
      createTodo({ title: '新管理待办' }, adminId, 'test-user');

      const adminResult = await withContext({ agentName: 'admin' }, () =>
        todoTools.handleTool('list_todos', { status: 'all' }),
      );
      const adminParsed = JSON.parse(adminResult!);
      expect(Array.isArray(adminParsed)).toBe(true);
      expect(adminParsed.map((t: any) => t.title)).toEqual(
        expect.arrayContaining(['旧学习待办', '新管理待办']),
      );

      const learningResult = await withContext({ agentName: 'learning-test' }, () =>
        todoTools.handleTool('list_todos', { status: 'all' }),
      );
      const learningParsed = JSON.parse(learningResult!);
      expect(learningParsed.map((t: any) => t.title)).toContain('旧学习待办');
      expect(learningParsed.map((t: any) => t.title)).not.toContain('新管理待办');

      const updateResult = await withContext({ agentName: 'admin' }, () =>
        todoTools.handleTool('update_todo', { id: legacy.id, status: 'done' }),
      );
      expect(JSON.parse(updateResult!).success).toBe(true);
      expect(listTodos({ status: 'done' }, learningAgentId, 'legacy-user').map(t => t.title)).toContain('旧学习待办');
    });

    it('lists explicitly aliased wework todos from feishu without merging same-name users', async () => {
      const { createTodo, listTodos } = await import('../../../src/commands/todo.js');
      const { registerUserAliases } = await import('../../../src/auth/rbac.js');
      const { getAgent } = await import('../../../src/llm/agents/config.js');
      const learningAgentId = getAgent('learning-test').id;

      unit.db.prepare(
        `INSERT OR IGNORE INTO users (id, username, role, display_name) VALUES (?, ?, 'user', ?)`,
      ).run('feishu_union_on_xu', 'xujun_feishu', '许骏');
      unit.db.prepare(
        `INSERT OR IGNORE INTO users (id, username, role, display_name) VALUES (?, ?, 'user', ?)`,
      ).run('wework_explicit_alias', 'xujun_wework', '许骏');
      unit.db.prepare(
        `INSERT OR IGNORE INTO users (id, username, role, display_name) VALUES (?, ?, 'user', ?)`,
      ).run('wework_same_name', 'same_name', '许骏');

      registerUserAliases('feishu_union_on_xu', ['wework_explicit_alias'], 'known cross-platform test alias');
      createTodo({ title: '企微旧待办' }, learningAgentId, 'wework_explicit_alias');
      createTodo({ title: '同名但未绑定待办' }, learningAgentId, 'wework_same_name');

      const listed = listTodos({ status: 'all' }, undefined, 'feishu_union_on_xu');
      expect(listed.map(t => t.title)).toContain('企微旧待办');
      expect(listed.map(t => t.title)).not.toContain('同名但未绑定待办');
    });

    it('unknown tool returns null', async () => {
      const todoTools = await import('../../../src/tools/todo-tools.js');
      const result = await todoTools.handleTool('nonexistent_tool', {});
      expect(result).toBeNull();
    });
  });
});
