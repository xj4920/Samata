import { afterEach, describe, expect, it, vi } from 'vitest';

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('fs');
    vi.doUnmock('../../../src/runtime/execution-context.js');
  });

  it('does not throw when file logging is not writable', async () => {
    const appendFileSync = vi.fn(() => {
      throw new Error('EACCES: permission denied');
    });
    const fsMock = {
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      appendFileSync,
    };

    vi.doMock('fs', () => ({ default: fsMock }));
    vi.doMock('../../../src/runtime/execution-context.js', () => ({
      captureOutputLine: vi.fn(),
      getExecutionContext: vi.fn(() => null),
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { log } = await import('../../../src/utils/logger.js');

    expect(() => log.file('[test] hello')).not.toThrow();
    expect(appendFileSync).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('文件日志写入失败'));
  });
});
