import { describe, expect, it, vi } from 'vitest';
import { SingleFlightCoordinator } from '../../../src/feishu/single-flight-coordinator.js';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('cancelled', 'AbortError'));
    }, { once: true });
  });
}

describe('SingleFlightCoordinator', () => {
  it('aborts superseded runs and commits only the latest merged input', async () => {
    vi.useFakeTimers();
    const runs: string[][] = [];
    const commits: string[] = [];

    const coordinator = new SingleFlightCoordinator<string, string>({
      debounceMs: 10,
      quietMs: 10,
      run: async ({ messages, abortSignal }) => {
        runs.push(messages);
        await sleep(50, abortSignal);
        return messages.join('+');
      },
      commit: async (_request, result) => {
        commits.push(result);
      },
    });

    coordinator.enqueue('出卷子');
    await vi.advanceTimersByTimeAsync(10);
    coordinator.enqueue('要 Word');
    coordinator.enqueue('空格大一点');

    await vi.runAllTimersAsync();

    expect(runs).toEqual([
      ['出卷子'],
      ['要 Word', '空格大一点'],
    ]);
    expect(commits).toEqual(['要 Word+空格大一点']);

    vi.useRealTimers();
  });

  it('cancels a completed draft during the quiet window before commit', async () => {
    vi.useFakeTimers();
    const commits: string[] = [];

    const coordinator = new SingleFlightCoordinator<string, string>({
      debounceMs: 5,
      quietMs: 50,
      run: async ({ messages }) => messages.join('+'),
      commit: async (_request, result) => {
        commits.push(result);
      },
    });

    coordinator.enqueue('旧文件');
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(10);
    coordinator.enqueue('改成新版');
    await vi.runAllTimersAsync();

    expect(commits).toEqual(['改成新版']);

    vi.useRealTimers();
  });
});
