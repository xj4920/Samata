import { afterEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';

class MockSupersededTurnError extends Error {
  code = 'SUPERSEDED_TURN';

  constructor(message = 'superseded') {
    super(message);
    this.name = 'SupersededTurnError';
  }
}

const mockRunAgenticChat = vi.hoisted(() => vi.fn());

vi.mock('../../../src/llm/agent.js', () => ({
  runAgenticChat: mockRunAgenticChat,
  SupersededTurnError: MockSupersededTurnError,
  isSupersededTurnError: (err: unknown) =>
    err instanceof MockSupersededTurnError ||
    (typeof err === 'object' && err !== null && (err as any).code === 'SUPERSEDED_TURN'),
}));

describe('agent turn coordinator', () => {
  afterEach(async () => {
    const { clearActiveAgentTurnsForTest } = await import('../../../src/session/agent-turn-coordinator.js');
    clearActiveAgentTurnsForTest();
    mockRunAgenticChat.mockReset();
  });

  it('supersedes an in-flight turn and commits only the restarted turn', async () => {
    const { makeAgentTurnKey, runCoordinatedAgentTurn } = await import('../../../src/session/agent-turn-coordinator.js');
    const history: Anthropic.MessageParam[] = [{ role: 'user', content: '历史问题' }];
    const user = { id: 'u1', username: 'alice', role: 'user' as const };
    const inputs: string[] = [];

    mockRunAgenticChat.mockImplementation(async (workingHistory, input, _user, options) => {
      inputs.push(input);
      if (inputs.length === 1) {
        await new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true });
        });
      }
      workingHistory.push({ role: 'user', content: input });
      workingHistory.push({ role: 'assistant', content: '最终回答' });
      return '最终回答';
    });

    const key = makeAgentTurnKey('cli', undefined, 'session-1');
    const first = runCoordinatedAgentTurn({
      key,
      history,
      input: '请分析这个问题',
      user,
      options: { streamEnabled: false },
      now: () => 1000,
    });

    await vi.waitFor(() => expect(mockRunAgenticChat).toHaveBeenCalledTimes(1));

    const second = await runCoordinatedAgentTurn({
      key,
      history,
      input: '补充：优先看今天的数据',
      user,
      options: { streamEnabled: false },
      now: () => 2000,
    });
    const firstResult = await first;

    expect(firstResult.status).toBe('superseded');
    expect(second).toEqual({ status: 'completed', reply: '最终回答', restartCount: 1 });
    expect(inputs[1]).toContain('请分析这个问题');
    expect(inputs[1]).toContain('补充：优先看今天的数据');
    expect(history).toEqual([
      { role: 'user', content: '历史问题' },
      { role: 'user', content: inputs[1] },
      { role: 'assistant', content: '最终回答' },
    ]);
  });

  it('keeps multiple supplements in chronological order', async () => {
    const { buildInputWithSupplements } = await import('../../../src/session/agent-turn-coordinator.js');

    const input = buildInputWithSupplements('原始问题', [
      { text: '第一次补充', receivedAt: 1000 },
      { text: '第二次补充', receivedAt: 2000 },
      { text: '第三次补充', receivedAt: 3000 },
    ]);

    expect(input.indexOf('第一次补充')).toBeLessThan(input.indexOf('第二次补充'));
    expect(input.indexOf('第二次补充')).toBeLessThan(input.indexOf('第三次补充'));
    expect(input).toContain('以较新的补充为准');
  });
});
