import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('wework-qa plugin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wework-qa-test-'));
    process.env.WEWORK_DUMP_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.WEWORK_DUMP_DIR;
  });

  function writeMessages(session: string, filename: string, messages: string[]) {
    const dir = path.join(tmpDir, session);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), messages.join('\n'));
  }

  describe('fetchWeworkMessages', () => {
    it('parses message lines correctly', async () => {
      const { fetchWeworkMessages } = await import('../../../plugins/wework-qa/src/commands.js');

      writeMessages('测试群', '2026-05-20.txt', [
        '[2026-05-20 10:00:00]: 张三: 请问期权行权价怎么计算？',
        '[2026-05-20 10:01:00]: 李四: 行权价按收盘价确定',
        'invalid line without timestamp',
        '[2026-05-20 10:02:00]: 王五: 好的，谢谢',
      ]);

      const messages = await fetchWeworkMessages({ limit: 100 });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        session: '测试群',
        sender: expect.any(String),
        content: expect.any(String),
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      });
    });

    it('filters by session name (case-insensitive)', async () => {
      const { fetchWeworkMessages } = await import('../../../plugins/wework-qa/src/commands.js');

      writeMessages('LinkRiver系统对接', '2026-05-20.txt', [
        '[2026-05-20 10:00:00]: 张三: 消息A',
      ]);
      writeMessages('磐松北上技术群', '2026-05-20.txt', [
        '[2026-05-20 10:00:00]: 李四: 消息B',
      ]);

      const messages = await fetchWeworkMessages({ session: 'linkriver', limit: 100 });
      expect(messages).toHaveLength(1);
      expect(messages[0].session).toBe('LinkRiver系统对接');
    });

    it('filters by keyword', async () => {
      const { fetchWeworkMessages } = await import('../../../plugins/wework-qa/src/commands.js');

      writeMessages('测试群', '2026-05-20.txt', [
        '[2026-05-20 10:00:00]: 张三: FIX连接超时了',
        '[2026-05-20 10:01:00]: 李四: 试试重启网关',
        '[2026-05-20 10:02:00]: 王五: 今天天气不错',
      ]);

      const messages = await fetchWeworkMessages({ keyword: 'FIX', limit: 100 });
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain('FIX');
    });

    it('filters by sender', async () => {
      const { fetchWeworkMessages } = await import('../../../plugins/wework-qa/src/commands.js');

      writeMessages('测试群', '2026-05-20.txt', [
        '[2026-05-20 10:00:00]: 张三: 消息1',
        '[2026-05-20 10:01:00]: 李四: 消息2',
        '[2026-05-20 10:02:00]: 张三: 消息3',
      ]);

      const messages = await fetchWeworkMessages({ sender: '张三', limit: 100 });
      expect(messages).toHaveLength(2);
      expect(messages.every(m => m.sender === '张三')).toBe(true);
    });

    it('respects limit', async () => {
      const { fetchWeworkMessages } = await import('../../../plugins/wework-qa/src/commands.js');

      const msgs = Array.from({ length: 20 }, (_, i) =>
        `[2026-05-20 10:${String(i).padStart(2, '0')}:00]: 张三: 消息${i}`
      );
      writeMessages('测试群', '2026-05-20.txt', msgs);

      const messages = await fetchWeworkMessages({ limit: 5 });
      expect(messages).toHaveLength(5);
    });

    it('sorts by time descending', async () => {
      const { fetchWeworkMessages } = await import('../../../plugins/wework-qa/src/commands.js');

      writeMessages('测试群', '2026-05-20.txt', [
        '[2026-05-20 09:00:00]: 张三: 早上',
        '[2026-05-20 12:00:00]: 张三: 中午',
        '[2026-05-20 18:00:00]: 张三: 晚上',
      ]);

      const messages = await fetchWeworkMessages({ limit: 100 });
      expect(messages[0].time).toBe('2026-05-20 18:00:00');
      expect(messages[2].time).toBe('2026-05-20 09:00:00');
    });

    it('supports context lines around keyword matches', async () => {
      const { fetchWeworkMessages } = await import('../../../plugins/wework-qa/src/commands.js');

      writeMessages('测试群', '2026-05-20.txt', [
        '[2026-05-20 10:00:00]: 张三: 之前的消息',
        '[2026-05-20 10:01:00]: 李四: FIX连接出问题了',
        '[2026-05-20 10:02:00]: 王五: 之后的回复',
        '[2026-05-20 10:03:00]: 赵六: 不相关',
      ]);

      const messages = await fetchWeworkMessages({ keyword: 'FIX', contextLines: 1, limit: 100 });
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.some(m => m.content.includes('FIX'))).toBe(true);
      expect(messages.some(m => m.content.includes('之前的消息'))).toBe(true);
    });
  });

  describe('extractWeworkQA', () => {
    it('returns empty array when no messages match', async () => {
      const { extractWeworkQA } = await import('../../../plugins/wework-qa/src/commands.js');

      writeMessages('测试群', '2026-05-20.txt', [
        '[2026-05-20 10:00:00]: 张三: 普通消息',
      ]);

      const result = await extractWeworkQA({ topics: ['不存在的关键词'] });
      expect(result).toEqual([]);
    });

    it('throws when LLM provider not injected', async () => {
      const { extractWeworkQA, setLLMProvider } = await import('../../../plugins/wework-qa/src/commands.js');

      writeMessages('测试群', '2026-05-20.txt', [
        '[2026-05-20 10:00:00]: 张三: 请问如何配置FIX连接？',
        '[2026-05-20 10:01:00]: 李四: 需要在gateway.xml中设置SenderCompID',
      ]);

      setLLMProvider(null as any, null as any);
      await expect(extractWeworkQA({ topics: ['FIX'] })).rejects.toThrow('LLM provider not injected');
    });

    it('extracts QA pairs with mocked LLM', async () => {
      const { extractWeworkQA, setLLMProvider } = await import('../../../plugins/wework-qa/src/commands.js');

      writeMessages('测试群', '2026-05-20.txt', [
        '[2026-05-20 10:00:00]: 张三: 请问FIX连接超时怎么办？',
        '[2026-05-20 10:01:00]: 李四: 检查HeartBtInt设置，建议30秒',
      ]);

      const mockResponse = JSON.stringify([{
        question: 'FIX连接超时如何处理？',
        answer: '检查HeartBtInt设置，建议设为30秒',
        tags: ['FIX', '连接'],
        time: '2026-05-20 10:00:00',
        questioner: '张三',
        answerer: '李四',
        context: 'FIX网关配置',
      }]);

      const mockProvider = {
        createMessage: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: mockResponse }],
        }),
      };

      setLLMProvider(() => mockProvider as any, () => 'test-model');

      const result = await extractWeworkQA({ topics: ['FIX'] });
      expect(result).toHaveLength(1);
      expect(result[0].question).toBe('FIX连接超时如何处理？');
      expect(result[0].answer).toContain('HeartBtInt');
      expect(result[0].session).toBe('测试群');
      expect(mockProvider.createMessage).toHaveBeenCalledTimes(1);
    });

    it('handles date and people filters', async () => {
      const { extractWeworkQA, setLLMProvider } = await import('../../../plugins/wework-qa/src/commands.js');

      writeMessages('测试群', '2026-05-20.txt', [
        '[2026-05-18 10:00:00]: 张三: FIX旧消息',
        '[2026-05-20 10:00:00]: 张三: FIX新消息',
        '[2026-05-20 11:00:00]: 李四: FIX回复',
      ]);

      const mockProvider = {
        createMessage: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '[]' }],
        }),
      };
      setLLMProvider(() => mockProvider as any, () => 'test-model');

      const result = await extractWeworkQA({
        topics: ['FIX'],
        startDate: '2026-05-19',
        people: ['李四'],
      });

      expect(result).toEqual([]);
      // LLM was called with only 李四's message from after 05-19
      const callArgs = mockProvider.createMessage.mock.calls[0][0];
      expect(callArgs.messages[0].content).toContain('李四');
      expect(callArgs.messages[0].content).not.toContain('旧消息');
    });
  });

  describe('plugin handleTool', () => {
    it('returns null for unknown tool name', async () => {
      const plugin = (await import('../../../plugins/wework-qa/index.js')).default;
      const result = await plugin.handleTool('nonexistent_tool', {}, {
        getCurrentUser: () => ({ id: '1', name: 'test', role: 'admin' }),
        getDataDir: () => tmpDir,
        getAgentId: () => 'test',
        getDeliveryContext: () => undefined,
      });
      expect(result).toBeNull();
    });
  });
});
