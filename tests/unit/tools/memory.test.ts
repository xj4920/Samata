import { describe, it, expect } from 'vitest';
import { useUnitDb, withContext } from '../../helpers/unit-harness.js';

describe('memory tools', () => {
  useUnitDb();

  describe('via tool handler', () => {
    it('save_memory and search_memory round-trip', async () => {
      const memoryTools = await import('../../../src/tools/memory-tools.js');

      await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, async () => {
        const saveResult = await memoryTools.handleTool('save_memory', {
          content: '用户偏好使用中文',
        });
        expect(saveResult).toBeTruthy();
        const saved = JSON.parse(saveResult!);
        expect(saved.success).toBe(true);

        const searchResult = await memoryTools.handleTool('search_memory', {
          keyword: '中文',
        });
        expect(searchResult).toBeTruthy();
        const found = JSON.parse(searchResult!);
        expect(found.length).toBeGreaterThan(0);
      });
    });

    it('delete_memory works', async () => {
      const memoryTools = await import('../../../src/tools/memory-tools.js');

      await withContext({ channel: 'cli', role: 'admin', agentName: 'otcclaw' }, async () => {
        const saveResult = await memoryTools.handleTool('save_memory', {
          content: '临时记忆',
        });
        const saved = JSON.parse(saveResult!);
        expect(saved.success).toBe(true);

        const delResult = await memoryTools.handleTool('delete_memory', {
          id: saved.id.slice(0, 8),
        });
        expect(delResult).toBeTruthy();
        const del = JSON.parse(delResult!);
        expect(del.success).toBe(true);
      });
    });
  });
});
