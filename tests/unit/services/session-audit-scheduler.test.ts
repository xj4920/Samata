import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

describe('session audit scheduler', () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samata-session-audit-'));
    process.chdir(tmpDir);
    mockSpawn.mockReset();
    delete process.env.SESSION_AUDIT_AGENTS;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('computes the next 23:30 run in Asia/Chongqing time', async () => {
    const { __sessionAuditSchedulerTest } = await import(
      '../../../src/services/session-audit-scheduler.js'
    );
    const now = Date.parse('2026-07-23T14:00:00.000Z');

    const delay = __sessionAuditSchedulerTest.computeNextDelay(
      '30 23 * * *',
      'Asia/Chongqing',
      now,
    );

    expect(delay).toBe(90 * 60 * 1000);
  });

  it('reconciles the previous day before auditing the current-day snapshot', async () => {
    const { __sessionAuditSchedulerTest } = await import(
      '../../../src/services/session-audit-scheduler.js'
    );

    expect(__sessionAuditSchedulerTest.auditDates(
      new Date('2026-07-22T16:30:00.000Z'),
      'Asia/Chongqing',
    )).toEqual(['2026-07-22', '2026-07-23']);
  });

  it('runs both dates under one lock with the fixed human-agent scope', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });
    const {
      runScheduledSessionAudit,
      isSessionAuditHealthy,
      __sessionAuditSchedulerTest,
    } = await import(
      '../../../src/services/session-audit-scheduler.js'
    );

    const ok = await runScheduledSessionAudit(
      new Date('2026-07-23T15:30:00.000Z'),
      'Asia/Chongqing',
    );

    expect(ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const firstArgs = mockSpawn.mock.calls[0][1] as string[];
    const secondArgs = mockSpawn.mock.calls[1][1] as string[];
    expect(firstArgs).toEqual(expect.arrayContaining([
      '--from=2026-07-22',
      '--to=2026-07-22',
      '--agents=ticlaw,otcclaw',
      '--human-only',
      '--pg',
    ]));
    expect(secondArgs).toEqual(expect.arrayContaining([
      '--from=2026-07-23',
      '--to=2026-07-23',
    ]));
    expect(fs.existsSync(path.join(
      tmpDir,
      'logs/daily_usage/.session-audit.lock',
    ))).toBe(false);
    expect(isSessionAuditHealthy()).toBe(true);
    __sessionAuditSchedulerTest.writeScheduleHeartbeat({
      nextRunAt: '2026-07-24T15:30:00.000Z',
    });
    const heartbeat = JSON.parse(fs.readFileSync(path.join(
      tmpDir,
      'logs/daily_usage/.session-audit-heartbeat.json',
    ), 'utf8'));
    expect(heartbeat.status).toBe('completed');
  });
});
