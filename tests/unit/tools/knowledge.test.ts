import { describe, it, expect } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('knowledge tools', () => {
  useUnitDb();

  async function getAgentId(name: string): Promise<string> {
    const { getAgent } = await import('../../../src/llm/agents/config.js');
    return getAgent(name).id;
  }

  describe('addKnowledge / fetchKnowledge / updateKnowledgeById / deleteKnowledge', () => {
    it('adds and fetches knowledge', async () => {
      const { addKnowledge, fetchKnowledge } = await import('../../../src/commands/knowledge.js');
      const agentId = await getAgentId('otcclaw');

      const add = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        addKnowledge(
          { question: '什么是OTC？', answer: 'OTC是场外交易市场', tags: 'OTC,金融' },
          agentId,
        ),
      );
      expect(add.success).toBe(true);
      expect(add.id).toBeTruthy();

      const result = fetchKnowledge('OTC', agentId);
      expect(result.faq.length).toBeGreaterThan(0);
      expect(result.faq[0].question).toContain('OTC');
    });

    it('updates knowledge', async () => {
      const { addKnowledge, updateKnowledgeById } = await import('../../../src/commands/knowledge.js');
      const agentId = await getAgentId('otcclaw');

      const { id } = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        addKnowledge({ question: '旧问题', answer: '旧答案' }, agentId),
      ) as { success: true; id: string };

      const updated = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        updateKnowledgeById(id.slice(0, 8), { answer: '新答案' }, agentId),
      );
      expect(updated.success).toBe(true);
    });

    it('deletes knowledge', async () => {
      const { addKnowledge, deleteKnowledge, fetchKnowledge } = await import('../../../src/commands/knowledge.js');
      const agentId = await getAgentId('otcclaw');

      const { id } = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        addKnowledge({ question: '删除测试', answer: '会被删除' }, agentId),
      ) as { success: true; id: string };

      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        deleteKnowledge(id.slice(0, 8), agentId),
      );
      expect(result.success).toBe(true);

      const search = fetchKnowledge('删除测试', agentId);
      expect(search.faq.length).toBe(0);
    });

    it('add with empty question fails', async () => {
      const { addKnowledge } = await import('../../../src/commands/knowledge.js');
      const agentId = await getAgentId('otcclaw');
      const result = await withContext({ channel: 'cli', role: 'admin' }, () =>
        addKnowledge({ question: '', answer: 'test' }, agentId),
      );
      expect(result.success).toBe(false);
    });
  });

  describe('agent scoping', () => {
    it('knowledge is scoped per agent', async () => {
      const { addKnowledge, fetchKnowledge } = await import('../../../src/commands/knowledge.js');
      const otcId = await getAgentId('otcclaw');
      const docId = await getAgentId('doctor');

      await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        addKnowledge({ question: 'OTC问题', answer: '仅OTC' }, otcId),
      );
      await withContext({ channel: 'cli', role: 'admin', agentName: 'doctor' }, () =>
        addKnowledge({ question: '医疗问题', answer: '仅医疗' }, docId),
      );

      const otcSearch = fetchKnowledge('OTC', otcId);
      const docSearch = fetchKnowledge('OTC', docId);

      expect(otcSearch.faq.length).toBeGreaterThan(0);
      expect(docSearch.faq.length).toBe(0);
    });
  });

  describe('tool handler', () => {
    it('search_knowledge via handleTool', async () => {
      const knowledgeTools = await import('../../../src/tools/knowledge-tools.js');
      const { addKnowledge } = await import('../../../src/commands/knowledge.js');
      const agentId = await getAgentId('otcclaw');

      await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        addKnowledge({ question: 'handler测试', answer: '通过handler' }, agentId),
      );

      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        knowledgeTools.handleTool('search_knowledge', { keyword: 'handler' }),
      );
      expect(result).toBeTruthy();
      const parsed = JSON.parse(result!);
      expect(parsed.faq || parsed.wiki || parsed.documents).toBeDefined();
    });

    it('add_knowledge via handleTool', async () => {
      const knowledgeTools = await import('../../../src/tools/knowledge-tools.js');

      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        knowledgeTools.handleTool('add_knowledge', {
          question: '新增测试',
          answer: '通过tool handler新增',
        }),
      );
      expect(result).toBeTruthy();
      const parsed = JSON.parse(result!);
      expect(parsed.success).toBe(true);
    });
  });
});
