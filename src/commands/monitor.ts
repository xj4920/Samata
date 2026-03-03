import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../db/connection.js';
import { getCurrentUser } from '../auth/rbac.js';
import { getProviderName, getModelName } from '../llm/provider.js';
import { isMonitorRunning } from '../services/wework-monitor.js';
import { isTelegramBotRunning } from '../telegram/bot.js';
import { isFeishuBotRunning } from '../feishu/bot.js';
import { log } from '../utils/logger.js';

// --- git hash (cached at module load) ---
let gitHash = '';
try {
  gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch { /* not a git repo */ }

// --- version from package.json ---
let version = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
  version = pkg.version ?? version;
} catch { /* ignore */ }

// --- app start time ---
const startedAt = Date.now();

export interface SystemStatus {
  name: string;
  version: string;
  gitHash: string;
  model: string | null;       // "anthropic/claude-sonnet-xxx" or null if LLM disabled
  knowledgeCount: number;
  skillCount: number;
  user: { username: string; role: string };
  uptime: string;             // e.g. "2h 35m"
  services: {
    name: string;
    running: boolean;
    detail?: string;          // e.g. "(ws)"
  }[];
}

function formatUptime(): string {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function fetchSystemStatus(): SystemStatus {
  const db = getDb();
  const knowledgeCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as { c: number }).c;
  const skillCount = (db.prepare('SELECT COUNT(*) as c FROM skills').get() as { c: number }).c;

  const user = getCurrentUser();

  // LLM model string
  let model: string | null = null;
  try {
    model = `${getProviderName()}/${getModelName()}`;
  } catch { /* LLM not initialized */ }

  const feishuMode = process.env.FEISHU_MODE || 'ws';

  return {
    name: '衍语 YanYu',
    version,
    gitHash,
    model,
    knowledgeCount,
    skillCount,
    user: { username: user.username, role: user.role },
    uptime: formatUptime(),
    services: [
      { name: '企微监控', running: isMonitorRunning() },
      { name: '飞书 Bot', running: isFeishuBotRunning(), detail: feishuMode },
      { name: 'Telegram', running: isTelegramBotRunning() },
    ],
  };
}

export function formatSystemStatus(s: SystemStatus): string {
  const hashPart = s.gitHash ? ` (${s.gitHash})` : '';
  const lines: string[] = [];

  lines.push(`🐾 ${s.name} ${s.version}${hashPart}`);
  lines.push(`🧠 Model: ${s.model ?? '未启用'}`);
  lines.push(`📚 Knowledge: ${s.knowledgeCount} 条 · 🎯 Skills: ${s.skillCount} 个`);
  lines.push(`👤 User: ${s.user.username} (${s.user.role})`);
  lines.push(`⏱  Uptime: ${s.uptime}`);
  lines.push('');
  lines.push('📡 Services:');
  for (const svc of s.services) {
    const icon = svc.running ? '✅' : '❌';
    const state = svc.running ? '运行中' : '未启动';
    const detail = svc.detail ? ` (${svc.detail})` : '';
    lines.push(`  ${icon} ${svc.name.padEnd(8)} ${state}${detail}`);
  }

  return lines.join('\n');
}

export function status(): void {
  const s = fetchSystemStatus();
  log.print(formatSystemStatus(s));
}
