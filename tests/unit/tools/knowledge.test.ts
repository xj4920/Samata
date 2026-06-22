import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('knowledge tools', () => {
  useUnitDb();

  const standardTestDocRoot = path.resolve(process.cwd(), 'data/documents/standard-test');
  const unitDocDirs = ['unit-date-old', 'unit-date-current', 'unit-date-undated'];

  afterEach(() => {
    for (const dir of unitDocDirs) {
      fs.rmSync(path.join(standardTestDocRoot, dir), { recursive: true, force: true });
    }
  });

  async function getAgentId(name: string): Promise<string> {
    const { getAgent } = await import('../../../src/llm/agents/config.js');
    return getAgent(name).id;
  }

  function writeParsedDoc(dirName: string, fields: Record<string, string>, body: string): void {
    const dir = path.join(standardTestDocRoot, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const frontmatter = [
      '---',
      ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'parsed.md'), `${frontmatter}${body}\n`, 'utf-8');
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
      const secondAgentId = await getAgentId('standard-test');

      await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, () =>
        addKnowledge({ question: 'OTC问题', answer: '仅OTC' }, otcId),
      );
      await withContext({ channel: 'cli', role: 'admin', agentName: 'standard-test' }, () =>
        addKnowledge({ question: '标准问题', answer: '仅标准测试' }, secondAgentId),
      );

      const otcSearch = fetchKnowledge('OTC', otcId);
      const secondSearch = fetchKnowledge('OTC', secondAgentId);

      expect(otcSearch.faq.length).toBeGreaterThan(0);
      expect(secondSearch.faq.length).toBe(0);
    });
  });

  describe('document date filtering', () => {
    it('filters imported documents by doc_date and returns doc_date', async () => {
      const { fetchKnowledge } = await import('../../../src/commands/knowledge.js');
      const knowledgeTools = await import('../../../src/tools/knowledge-tools.js');
      const agentId = await getAgentId('standard-test');

      writeParsedDoc('unit-date-old', {
        document_id: 'unit-date-old-doc',
        agent_id: agentId,
        title: '"2025 old DateGuardUnique"',
        tags: 'DateGuardUnique',
        doc_date: '2025-06-20',
      }, '# DateGuardUnique\n2025 年旧拒单清理日志。');
      writeParsedDoc('unit-date-current', {
        document_id: 'unit-date-current-doc',
        agent_id: agentId,
        title: '"2026 current DateGuardUnique"',
        tags: 'DateGuardUnique',
        doc_date: '2026-06-22',
      }, '# DateGuardUnique\n2026 年当天拒单日志。');
      writeParsedDoc('unit-date-undated', {
        document_id: 'unit-date-undated-doc',
        agent_id: agentId,
        title: '"undated DateGuardUnique"',
        tags: 'DateGuardUnique',
      }, '# DateGuardUnique\n缺少材料日期的历史材料。');

      const filtered = fetchKnowledge('DateGuardUnique', agentId, {
        documentDate: { dateFrom: '2026-06-22', dateTo: '2026-06-22' },
      });
      expect(filtered.documents.map(d => d.document_id)).toEqual(['unit-date-current-doc']);
      expect(filtered.documents[0].doc_date).toBe('2026-06-22');

      const withUndated = fetchKnowledge('DateGuardUnique', agentId, {
        documentDate: { dateFrom: '2026-06-22', dateTo: '2026-06-22', includeUndated: true },
      });
      expect(withUndated.documents.map(d => d.document_id).sort()).toEqual(['unit-date-current-doc', 'unit-date-undated-doc']);

      const result = await withContext({ channel: 'cli', role: 'admin', agentName: 'standard-test' }, () =>
        knowledgeTools.handleTool('search_knowledge', {
          keyword: 'DateGuardUnique',
          date_from: '2026-06-22',
          date_to: '2026-06-22',
        }),
      );
      const parsed = JSON.parse(result!);
      expect(parsed.documents).toHaveLength(1);
      expect(parsed.documents[0]).toMatchObject({
        document_id: 'unit-dat',
        doc_date: '2026-06-22',
      });
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
