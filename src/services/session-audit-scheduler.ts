import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CronExpressionParser } from 'cron-parser';

const DEFAULT_CRON = '30 23 * * *';
const DEFAULT_TIMEZONE = 'Asia/Chongqing';
const DEFAULT_AGENTS = 'ticlaw,otcclaw';
const LOCK_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MAX_AGE_MS = 36 * 60 * 60 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function auditDir(): string {
  return path.resolve(process.cwd(), 'logs', 'daily_usage');
}

function lockPath(): string {
  return path.join(auditDir(), '.session-audit.lock');
}

function heartbeatPath(): string {
  return path.join(auditDir(), '.session-audit-heartbeat.json');
}

function writeHeartbeat(status: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(auditDir(), { recursive: true });
  fs.writeFileSync(
    heartbeatPath(),
    `${JSON.stringify({ status, updatedAt: new Date().toISOString(), ...extra })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.chmodSync(heartbeatPath(), 0o600);
}

function writeScheduleHeartbeat(extra: Record<string, unknown>): void {
  let status = 'scheduled';
  let previous: Record<string, unknown> = {};
  try {
    previous = JSON.parse(fs.readFileSync(heartbeatPath(), 'utf8')) as Record<string, unknown>;
    if (typeof previous.status === 'string') status = previous.status;
  } catch {
    // The first schedule creates the heartbeat.
  }
  const { status: _status, updatedAt: _updatedAt, ...preserved } = previous;
  writeHeartbeat(status, { ...preserved, ...extra });
}

function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function previousDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function auditDates(now = new Date(), timezone = DEFAULT_TIMEZONE): string[] {
  const today = localDate(now, timezone);
  return [previousDate(today), today];
}

function acquireLock(): boolean {
  fs.mkdirSync(auditDir(), { recursive: true });
  const now = Date.now();
  try {
    const current = JSON.parse(fs.readFileSync(lockPath(), 'utf8')) as { expiresAt?: number };
    if ((current.expiresAt ?? 0) > now) return false;
    fs.unlinkSync(lockPath());
  } catch {
    try { fs.unlinkSync(lockPath()); } catch { /* absent */ }
  }

  try {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: process.pid, acquiredAt: now, expiresAt: now + LOCK_MS }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try { fs.unlinkSync(lockPath()); } catch { /* ignore */ }
}

function runAuditCommand(date: string, agents: string): Promise<void> {
  const args = [
    '--import',
    'tsx/esm',
    'scripts/analyze-log.ts',
    '--source=telemetry',
    `--from=${date}`,
    `--to=${date}`,
    `--agents=${agents}`,
    '--human-only',
    '--allow-missing',
    '--quiet',
    '--pg',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`审计子进程失败: date=${date} code=${code ?? 'null'} signal=${signal ?? 'none'}`));
    });
  });
}

export async function runScheduledSessionAudit(
  now = new Date(),
  timezone = process.env.SESSION_AUDIT_TIMEZONE || DEFAULT_TIMEZONE,
): Promise<boolean> {
  if (running || !acquireLock()) return false;
  running = true;
  const agents = process.env.SESSION_AUDIT_AGENTS || DEFAULT_AGENTS;
  const dates = auditDates(now, timezone);
  writeHeartbeat('running', { agents, dates });
  try {
    for (const date of dates) await runAuditCommand(date, agents);
    writeHeartbeat('completed', { agents, dates });
    return true;
  } catch (error) {
    writeHeartbeat('failed', {
      agents,
      dates,
      error: String(error instanceof Error ? error.message : error).slice(0, 1000),
    });
    console.error(`[session-audit] ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    running = false;
    releaseLock();
  }
}

function computeNextDelay(cron: string, timezone: string, now = Date.now()): number {
  const expression = CronExpressionParser.parse(cron, {
    tz: timezone,
    currentDate: new Date(now),
  });
  return Math.max(1, expression.next().getTime() - now);
}

function scheduleNext(): void {
  const cron = process.env.SESSION_AUDIT_CRON || DEFAULT_CRON;
  const timezone = process.env.SESSION_AUDIT_TIMEZONE || DEFAULT_TIMEZONE;
  const delay = computeNextDelay(cron, timezone);
  const nextRunAt = new Date(Date.now() + delay).toISOString();
  // Keep the latest run result. In particular, a failed run must remain
  // unhealthy instead of being overwritten by the next scheduled timestamp.
  writeScheduleHeartbeat({ cron, timezone, nextRunAt });
  timer = setTimeout(async () => {
    timer = null;
    await runScheduledSessionAudit(new Date(), timezone);
    scheduleNext();
  }, delay);
  console.warn(`[session-audit] 下一次执行: ${nextRunAt} (${cron}, ${timezone})`);
}

export function isSessionAuditHealthy(now = Date.now()): boolean {
  try {
    const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath(), 'utf8')) as {
      status?: string;
      updatedAt?: string;
    };
    const age = now - new Date(heartbeat.updatedAt ?? '').getTime();
    return heartbeat.status !== 'failed' && Number.isFinite(age) && age >= 0 && age <= HEARTBEAT_MAX_AGE_MS;
  } catch {
    return false;
  }
}

export const __sessionAuditSchedulerTest = {
  auditDates,
  computeNextDelay,
  localDate,
  writeScheduleHeartbeat,
};

async function main(): Promise<void> {
  fs.mkdirSync(auditDir(), { recursive: true });
  process.once('SIGTERM', () => {
    if (timer) clearTimeout(timer);
    process.exit(0);
  });
  process.once('SIGINT', () => {
    if (timer) clearTimeout(timer);
    process.exit(0);
  });

  if (process.env.SESSION_AUDIT_RUN_ON_START === '1') {
    const ok = await runScheduledSessionAudit();
    if (!ok && process.env.SESSION_AUDIT_ONESHOT === '1') process.exit(1);
  }
  if (process.env.SESSION_AUDIT_ONESHOT === '1') process.exit(0);
  scheduleNext();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
