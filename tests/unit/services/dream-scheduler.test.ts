import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunDreamForAll = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/dream-analyze.js', () => ({
  runDreamForAll: mockRunDreamForAll,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  log: {
    warn: vi.fn(),
    file: vi.fn(),
    error: vi.fn(),
  },
}));

describe('dream scheduler', () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samata-dream-scheduler-'));
    process.chdir(tmpDir);
    mockRunDreamForAll.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('computes the next 03:00 run in Asia/Chongqing time', async () => {
    const { __dreamSchedulerTest } = await import('../../../src/services/dream-scheduler.js');
    const now = Date.parse('2026-06-10T18:00:00.000Z');

    const delay = __dreamSchedulerTest.computeNextDelay('0 3 * * *', 'Asia/Chongqing', now);

    expect(delay).toBe(60 * 60 * 1000);
  });

  it('runs dream analysis under a local lock', async () => {
    mockRunDreamForAll.mockResolvedValue(undefined);
    const { runScheduledDream } = await import('../../../src/services/dream-scheduler.js');

    const ok = await runScheduledDream('2026-06-03');

    expect(ok).toBe(true);
    expect(mockRunDreamForAll).toHaveBeenCalledWith('2026-06-03');
    expect(fs.existsSync(path.join(tmpDir, 'data', 'dreams', '.dream-scheduler.lock'))).toBe(false);
  });
});
