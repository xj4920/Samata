import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { getDb } from '../db/connection.js';
import { getCurrentUser, isAgentAdmin, isSystemAdmin } from '../auth/rbac.js';
import { getExecutionChannel, getExecutionContext } from '../runtime/execution-context.js';
import { getProviderName, getModelName, getProviderByName, type ProviderName } from '../llm/provider.js';
import { isTelegramBotRunning } from '../telegram/bot.js';
import { isFeishuBotRunning, listFeishuBotHealth, type FeishuBotHealth } from '../feishu/bot.js';
import { isWeworkBotRunning } from '../wework/bot.js';
import { getCurrentAgent, getGlobalTools } from '../llm/agent.js';
import { getAgentTools, getBotAppLLM } from '../llm/agents/config.js';
import { getToolCategoryMap } from '../tools/index.js';
import { getCommandEntries } from './router.js';
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
  agent: { name: string; displayName: string };
  availableCommands: string[];   // slash commands visible to current agent
  availableTools: string[];      // LLM tools available to current agent
  uptime: string;             // e.g. "2h 35m"
  ipAddresses: string[];      // local non-loopback IPv4 addresses
  services: {
    name: string;
    running: boolean;
    detail?: string;          // e.g. "(ws)"
  }[];
  feishuBots: FeishuBotHealth[];
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
  const user = getCurrentUser();
  const agent = getCurrentAgent();

  const agentId = agent?.id;
  const knowledgeCount = agentId
    ? (db.prepare('SELECT COUNT(*) as c FROM knowledge_agents WHERE agent_id = ?').get(agentId) as { c: number }).c
    : (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as { c: number }).c;
  const skillCount = agentId
    ? (db.prepare('SELECT COUNT(*) as c FROM skills WHERE agent_id IS NULL OR agent_id = ?').get(agentId) as { c: number }).c
    : (db.prepare('SELECT COUNT(*) as c FROM skills').get() as { c: number }).c;

  // LLM model string — priority: bot_apps.config.llm > agent config > global override > provider default
  let model: string | null = null;
  try {
    const ctx = getExecutionContext();
    const botLLM = ctx?.appId ? getBotAppLLM(ctx.appId) : {};
    const effProviderName = botLLM.provider ?? agent?.provider ?? getProviderName();
    const providerRef = getProviderByName(effProviderName as ProviderName);
    const effModelName = botLLM.model ?? agent?.model ?? providerRef?.defaultModel ?? getModelName();
    model = `${effProviderName}/${effModelName}`;
  } catch { /* LLM not initialized */ }

  const feishuMode = process.env.FEISHU_MODE || 'ws';

  // Local IP addresses
  const ipAddresses: string[] = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ipAddresses.push(addr.address);
      }
    }
  }

  // Available commands (filtered by current agent)
  const availableCommands = getCommandEntries().map(e => e.name);

  // Available LLM tools (filtered by agent's toolsMode and current user's role)
  const agentConfig = agent ?? undefined;
  const userIsAdmin = agentConfig ? isAgentAdmin(agentConfig.id) : true;
  const availableTools = agentConfig
    ? getAgentTools(agentConfig, getGlobalTools(), userIsAdmin).map(t => t.name)
    : getGlobalTools().map(t => t.name);

  const channel = getExecutionChannel();
  let displayRole: string;
  if (channel === 'cli') {
    displayRole = isSystemAdmin() ? 'system admin' : 'user';
  } else {
    displayRole = (agentId && isAgentAdmin(agentId)) ? 'agent admin' : 'member';
  }

  return {
    name: 'Samata',
    version,
    gitHash,
    model,
    knowledgeCount,
    skillCount,
    user: { username: user.username, role: displayRole },
    agent: { name: agent?.name ?? 'unknown', displayName: agent?.displayName ?? 'unknown' },
    availableCommands,
    availableTools,
    uptime: formatUptime(),
    ipAddresses,
    services: [
      { name: '企微 Bot', running: isWeworkBotRunning() },
      { name: '飞书 Bot', running: isFeishuBotRunning(), detail: feishuMode },
      { name: 'Telegram', running: isTelegramBotRunning() },
    ],
    feishuBots: channel === 'cli' ? listFeishuBotHealth() : [],
  };
}

function formatAgoMs(ms: number): string {
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

const SEP = '─────────────────';

export function formatSystemStatus(s: SystemStatus): string {
  const hashPart = s.gitHash ? ` (${s.gitHash})` : '';
  const lines: string[] = [];

  lines.push(`🐾 ${s.name} ${s.version}${hashPart}`);
  lines.push(`🧠 Model: ${s.model ?? '未启用'}`);
  lines.push(`📚 Knowledge: ${s.knowledgeCount} 条 · 🎯 Skills: ${s.skillCount} 个`);
  lines.push(`👤 User: ${s.user.username} (${s.user.role})`);
  lines.push(`🤖 Agent: ${s.agent.displayName} (${s.agent.name})`);
  lines.push(`⏱  Uptime: ${s.uptime}`);
  if (s.ipAddresses.length > 0) {
    lines.push(`🌐 IP: ${s.ipAddresses.join(' · ')}`);
  }

  lines.push(SEP);
  lines.push('📡 Services:');
  for (const svc of s.services) {
    const icon = svc.running ? '✅' : '❌';
    const state = svc.running ? '运行中' : '未启动';
    const detail = svc.detail ? ` (${svc.detail})` : '';
    lines.push(`  ${icon} ${svc.name.padEnd(8)} ${state}${detail}`);
  }

  if (s.feishuBots.length > 0) {
    lines.push('  飞书 Bots:');
    const nameWidth = Math.max(...s.feishuBots.map(b => b.appName.length), 4);
    for (const b of s.feishuBots) {
      const icon = b.restarting ? '♻️' : (b.healthy ? '✅' : '⚠️');
      const state = b.restarting ? 'RESTARTING' : (b.healthy ? 'healthy' : 'DEGRADED');
      const ago = formatAgoMs(b.msSinceHealthy);
      lines.push(`    ${icon} ${b.appName.padEnd(nameWidth)}  ${state}  (last ok ${ago})`);
    }
  }

  lines.push(SEP);
  lines.push(`🔧 Commands (${s.availableCommands.length}):`);
  lines.push(`  ${s.availableCommands.join('  ')}`);

  lines.push(SEP);
  lines.push(`🛠  Tools (${s.availableTools.length}):`);
  const categoryMap = getToolCategoryMap();
  const counts = new Map<string, number>();
  for (const name of s.availableTools) {
    const cat = categoryMap.get(name)
      ?? (name.startsWith('mcp_') ? 'MCP' : 'Plugin');
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const tags = [...counts.entries()].map(([cat, n]) => `${cat}(${n})`);
  lines.push(`  ${tags.join('  ')}`);

  return lines.join('\n');
}

export function status(): void {
  const s = fetchSystemStatus();
  log.print(formatSystemStatus(s));
}
