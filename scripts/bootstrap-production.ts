#!/usr/bin/env npx tsx
import 'dotenv/config';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { initDatabase } from '../src/db/schema.js';
import { closeDb, getDb } from '../src/db/connection.js';

type ToolsMode = 'all' | 'standard' | 'allowlist' | 'blocklist';
type UserToolsMode = 'inherit' | 'all' | 'allowlist' | 'blocklist';
type MemberRole = 'admin' | 'user';

interface AgentSpec {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  model?: string | null;
  provider?: string | null;
  toolsMode: ToolsMode;
  toolsList: string[];
  blockTools: string[];
  userToolsMode: UserToolsMode;
  userToolsList: string[];
  maxHistory?: number;
  members: Array<{ user: string; role: MemberRole }>;
}

interface WeworkBotSpec {
  id: string;
  name: string;
  agent: string;
  secret: string;
  showThinking?: boolean;
  autoStart?: boolean;
  config?: Record<string, unknown>;
}

interface BootstrapConfig {
  users?: {
    keep?: string[];
    keepPrefixes?: string[];
    removeNonWework?: boolean;
  };
  agents: AgentSpec[];
  weworkBots: WeworkBotSpec[];
  cleanup?: {
    removeNonTargetAgents?: boolean;
    removeAgents?: string[];
    removeNonWeworkAssignments?: boolean;
    removeUnlistedWeworkBots?: boolean;
  };
}

interface CliOptions {
  config?: string;
  apply: boolean;
  json: boolean;
  help: boolean;
  exportCurrent?: string;
}

const TARGET_AGENTS = ['admin', 'ticlaw', 'otcclaw'];
const REQUIRED_CONFIG_AGENTS = ['ticlaw', 'otcclaw'];
const DB_PATH = resolve(process.cwd(), 'data/samata.db');

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要参数`);
      i += 1;
      return value;
    };

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--config') options.config = next();
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--export-current') options.exportCurrent = next();
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function printHelp(): void {
  console.log(`用法:
  npx tsx scripts/bootstrap-production.ts --config config/production-bootstrap.local.json --dry-run
  npx tsx scripts/bootstrap-production.ts --config config/production-bootstrap.local.json --apply
  npx tsx scripts/bootstrap-production.ts --export-current config/production-bootstrap.local.json

说明:
  默认 dry-run，不写数据库。
  --apply 写库前会备份 data/samata.db。
  config 支持 \${ENV_NAME} 占位符，真实 secret 不应提交到仓库。`);
}

function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, name) => process.env[name] ?? match);
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnv(item)]));
  }
  return value;
}

function readConfig(path: string): BootstrapConfig {
  const configPath = resolve(process.cwd(), path);
  return expandEnv(JSON.parse(readFileSync(configPath, 'utf8'))) as BootstrapConfig;
}

function hasUnresolvedEnv(value: unknown): boolean {
  if (typeof value === 'string') return /\$\{[A-Z0-9_]+\}/i.test(value);
  if (Array.isArray(value)) return value.some(hasUnresolvedEnv);
  if (value && typeof value === 'object') return Object.values(value).some(hasUnresolvedEnv);
  return false;
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} 不能为空`);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} 必须是字符串数组`);
  }
}

function validateConfig(config: BootstrapConfig, apply: boolean): void {
  if (!Array.isArray(config.agents)) throw new Error('config.agents 必须是数组');
  if (!Array.isArray(config.weworkBots)) throw new Error('config.weworkBots 必须是数组');

  for (const name of REQUIRED_CONFIG_AGENTS) {
    if (!config.agents.some(agent => agent.name === name)) throw new Error(`缺少 agent 配置: ${name}`);
  }
  for (const name of TARGET_AGENTS) {
    if (!config.weworkBots.some(bot => bot.agent === name)) throw new Error(`缺少 ${name} 的企微 bot 绑定配置`);
  }

  for (const agent of config.agents) {
    if (agent.name === 'admin') throw new Error('admin agent 由系统默认自举，不应在生产配置中声明');
    if (!TARGET_AGENTS.includes(agent.name)) throw new Error(`不支持的生产 agent 配置: ${agent.name}`);
    assertString(agent.id, `agent(${agent.name}).id`);
    assertString(agent.name, `agent(${agent.id}).name`);
    assertString(agent.displayName, `agent(${agent.name}).displayName`);
    assertString(agent.toolsMode, `agent(${agent.name}).toolsMode`);
    assertString(agent.userToolsMode, `agent(${agent.name}).userToolsMode`);
    assertStringArray(agent.toolsList, `agent(${agent.name}).toolsList`);
    assertStringArray(agent.blockTools, `agent(${agent.name}).blockTools`);
    assertStringArray(agent.userToolsList, `agent(${agent.name}).userToolsList`);
    if (!Array.isArray(agent.members) || agent.members.length === 0) {
      throw new Error(`agent(${agent.name}).members 至少需要一个成员`);
    }
  }

  for (const bot of config.weworkBots) {
    assertString(bot.id, `weworkBot(${bot.agent}).id`);
    assertString(bot.name, `weworkBot(${bot.agent}).name`);
    assertString(bot.agent, `weworkBot(${bot.id}).agent`);
    if (!TARGET_AGENTS.includes(bot.agent)) throw new Error(`不支持的企微 bot agent: ${bot.agent}`);
    assertString(bot.secret, `weworkBot(${bot.id}).secret`);
    if (apply && hasUnresolvedEnv(bot.secret)) throw new Error(`weworkBot(${bot.id}).secret 仍包含未展开环境变量`);
  }
}

function openReadonlyDb(): Database.Database {
  if (!existsSync(DB_PATH)) throw new Error(`数据库不存在: ${DB_PATH}`);
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

async function backupDatabase(): Promise<string | null> {
  if (!existsSync(DB_PATH)) return null;
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupPath = resolve(process.cwd(), `data/backups/production-bootstrap-${timestamp}/samata.db`);
  mkdirSync(dirname(backupPath), { recursive: true });
  const readonly = openReadonlyDb();
  await readonly.backup(backupPath);
  readonly.close();
  return backupPath;
}

function parseJsonList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function maskSecret(secret: string): string {
  if (!secret) return '';
  if (hasUnresolvedEnv(secret)) return secret;
  return secret.length <= 8 ? '********' : `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function getAgentIdsByName(db: Database.Database, names: string[]): Map<string, string> {
  if (names.length === 0) return new Map();
  const placeholders = names.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id, name FROM agents WHERE name IN (${placeholders})`).all(...names) as Array<{ id: string; name: string }>;
  return new Map(rows.map(row => [row.name, row.id]));
}

function getNonTargetAgentIds(db: Database.Database): Map<string, string> {
  const placeholders = TARGET_AGENTS.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id, name FROM agents WHERE name NOT IN (${placeholders})`).all(...TARGET_AGENTS) as Array<{ id: string; name: string }>;
  return new Map(rows.map(row => [row.name, row.id]));
}

function getCleanupAgentIds(db: Database.Database, config: BootstrapConfig): Map<string, string> {
  const agentIds = config.cleanup?.removeNonTargetAgents === false
    ? new Map<string, string>()
    : getNonTargetAgentIds(db);
  for (const [name, id] of getAgentIdsByName(db, config.cleanup?.removeAgents ?? [])) {
    agentIds.set(name, id);
  }
  return agentIds;
}

function resolveMembers(db: Database.Database, spec: AgentSpec): Array<{ id: string; role: MemberRole }> {
  return spec.members.map(member => {
    const user = db.prepare('SELECT id FROM users WHERE id = ? OR username = ?').get(member.user, member.user) as { id: string } | undefined;
    if (!user) throw new Error(`agent(${spec.name}) member 不存在: ${member.user}`);
    return { id: user.id, role: member.role };
  });
}

function getUnlistedTargetMembers(db: Database.Database, config: BootstrapConfig): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (const agent of config.agents) {
    const members = resolveMembers(db, agent);
    const memberIds = [...new Set(members.map(member => member.id))];
    const placeholders = memberIds.map(() => '?').join(', ');
    rows.push(...db.prepare(`
      SELECT am.id, a.name AS agent, am.user_id AS userId, u.username, am.role
      FROM agent_members am
      JOIN agents a ON a.id = am.agent_id
      JOIN users u ON u.id = am.user_id
      WHERE am.agent_id = ? AND am.user_id NOT IN (${placeholders})
    `).all(agent.id, ...memberIds) as Array<Record<string, string>>);
  }
  return rows;
}

function cleanupCandidates(db: Database.Database, config: BootstrapConfig): Record<string, unknown> {
  const configuredAgents = new Set(config.agents.map(agent => agent.name));
  const configuredBotIds = new Set(config.weworkBots.map(bot => bot.id));
  const agentIds = getCleanupAgentIds(db, config);

  const nonWeworkAssignments = config.cleanup?.removeNonWeworkAssignments
    ? db.prepare("SELECT id, channel, app_id, target_id FROM agent_assignments WHERE channel != 'wework'").all()
    : [];
  const unlistedWeworkBots = config.cleanup?.removeUnlistedWeworkBots
    ? db.prepare(`SELECT id, name FROM bot_apps WHERE channel = 'wework'`).all()
        .filter((row: any) => !configuredBotIds.has(row.id))
    : [];

  const nonWeworkUsers = config.users?.removeNonWework
    ? db.prepare("SELECT id, username FROM users WHERE id != 'admin-001' AND id NOT LIKE 'wework_%' AND id NOT LIKE 'wework_user_%'").all()
    : [];

  return {
    configuredAgents: [...configuredAgents],
    removeAgents: [...agentIds.entries()].map(([name, id]) => ({ name, id })),
    unlistedTargetMembers: getUnlistedTargetMembers(db, config),
    nonWeworkAssignments,
    unlistedWeworkBots,
    nonWeworkUsers,
  };
}

function normalizeAgentId(db: Database.Database, spec: AgentSpec): void {
  const existing = db.prepare('SELECT id FROM agents WHERE name = ?').get(spec.name) as { id: string } | undefined;
  if (!existing || existing.id === spec.id) return;

  const idOwner = db.prepare('SELECT name FROM agents WHERE id = ?').get(spec.id) as { name: string } | undefined;
  if (idOwner && idOwner.name !== spec.name) {
    throw new Error(`agent id 冲突: ${spec.id} 已属于 ${idOwner.name}`);
  }

  const oldId = existing.id;
  for (const table of [
    'agent_members',
    'agent_assignments',
    'memory',
    'knowledge_agents',
    'todos',
    'wrong_questions',
    'documents',
    'scheduled_tasks',
    'telemetry_turn',
    'skills',
    'pricing_quotes',
    'reminders',
  ]) {
    try {
      db.prepare(`UPDATE ${table} SET agent_id = ? WHERE agent_id = ?`).run(spec.id, oldId);
    } catch {
      // Some future/old tables may not exist in every deployment.
    }
  }
  db.pragma('foreign_keys = OFF');
  db.prepare('UPDATE agents SET id = ? WHERE id = ?').run(spec.id, oldId);
  db.pragma('foreign_keys = ON');
}

function upsertAgent(db: Database.Database, spec: AgentSpec): void {
  normalizeAgentId(db, spec);
  db.prepare(`
    INSERT INTO agents (
      id, name, display_name, description, model, provider, tools_mode,
      tools_list, block_tools, preset, user_tools_mode, user_tools_list,
      max_history, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'admin-001')
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      display_name = excluded.display_name,
      description = excluded.description,
      model = excluded.model,
      provider = excluded.provider,
      tools_mode = excluded.tools_mode,
      tools_list = excluded.tools_list,
      block_tools = excluded.block_tools,
      user_tools_mode = excluded.user_tools_mode,
      user_tools_list = excluded.user_tools_list,
      max_history = excluded.max_history,
      updated_at = datetime('now')
  `).run(
    spec.id,
    spec.name,
    spec.displayName,
    spec.description ?? null,
    spec.model ?? null,
    spec.provider ?? null,
    spec.toolsMode,
    JSON.stringify(spec.toolsList),
    JSON.stringify(spec.blockTools),
    spec.userToolsMode,
    spec.userToolsList.length > 0 ? JSON.stringify(spec.userToolsList) : null,
    spec.maxHistory ?? 80,
  );
}

function upsertMembers(db: Database.Database, spec: AgentSpec): void {
  for (const member of resolveMembers(db, spec)) {
    db.prepare(`
      INSERT INTO agent_members (id, agent_id, user_id, role)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, user_id) DO UPDATE SET role = excluded.role
    `).run(`bootstrap-${spec.id}-${member.id}`, spec.id, member.id, member.role);
  }
}

function removeUnlistedTargetMembers(db: Database.Database, config: BootstrapConfig): void {
  for (const agent of config.agents) {
    const memberIds = [...new Set(resolveMembers(db, agent).map(member => member.id))];
    const placeholders = memberIds.map(() => '?').join(', ');
    db.prepare(`
      DELETE FROM agent_members
      WHERE agent_id = ? AND user_id NOT IN (${placeholders})
    `).run(agent.id, ...memberIds);
  }
}

function upsertBot(db: Database.Database, bot: WeworkBotSpec): void {
  db.prepare(`
    INSERT INTO bot_apps (id, channel, name, secret, config, show_thinking, auto_start)
    VALUES (?, 'wework', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      channel = excluded.channel,
      name = excluded.name,
      secret = excluded.secret,
      config = excluded.config,
      show_thinking = excluded.show_thinking,
      auto_start = excluded.auto_start
  `).run(
    bot.id,
    bot.name,
    bot.secret,
    stableJson(bot.config ?? {}),
    bot.showThinking === false ? 0 : 1,
    bot.autoStart === false ? 0 : 1,
  );
}

function upsertAssignment(db: Database.Database, bot: WeworkBotSpec, agentId: string): void {
  db.prepare("DELETE FROM agent_assignments WHERE channel = 'wework' AND app_id IS ? AND target_id IS NULL").run(bot.id);
  db.prepare('INSERT INTO agent_assignments (id, agent_id, channel, app_id, target_id) VALUES (?, ?, ?, ?, NULL)')
    .run(`bootstrap-wework-${bot.id}`, agentId, 'wework', bot.id);
}

function removeAgentData(db: Database.Database, name: string): void {
  const row = db.prepare('SELECT id FROM agents WHERE name = ?').get(name) as { id: string } | undefined;
  if (!row) return;
  const id = row.id;
  for (const table of [
    'scheduled_tasks',
    'telemetry_turn',
    'skills',
    'pricing_quotes',
    'documents',
    'wrong_questions',
    'todos',
    'knowledge_agents',
    'memory',
    'agent_assignments',
    'agent_members',
  ]) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(id);
    } catch {
      // Keep cleanup compatible with older deployments.
    }
  }
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function removeUnlistedRuntimeRows(db: Database.Database, config: BootstrapConfig): void {
  for (const name of getCleanupAgentIds(db, config).keys()) {
    if (TARGET_AGENTS.includes(name)) throw new Error(`不能删除核心 agent: ${name}`);
    removeAgentData(db, name);
  }

  if (config.cleanup?.removeNonWeworkAssignments) {
    db.prepare("DELETE FROM agent_assignments WHERE channel != 'wework'").run();
  }

  if (config.cleanup?.removeUnlistedWeworkBots) {
    const keepIds = new Set(config.weworkBots.map(bot => bot.id));
    const rows = db.prepare("SELECT id FROM bot_apps WHERE channel = 'wework'").all() as Array<{ id: string }>;
    for (const row of rows) {
      if (keepIds.has(row.id)) continue;
      db.prepare("DELETE FROM agent_assignments WHERE channel = 'wework' AND app_id IS ?").run(row.id);
      db.prepare('DELETE FROM bot_apps WHERE id = ?').run(row.id);
    }
  }

  if (config.users?.removeNonWework) {
    const keep = new Set(['admin-001', ...(config.users.keep ?? [])]);
    const prefixes = config.users.keepPrefixes ?? ['wework_', 'wework_user_'];
    const users = db.prepare('SELECT id FROM users').all() as Array<{ id: string }>;
    for (const user of users) {
      if (keep.has(user.id) || prefixes.some(prefix => user.id.startsWith(prefix))) continue;
      db.prepare('DELETE FROM user_aliases WHERE alias_user_id = ? OR canonical_user_id = ?').run(user.id, user.id);
      try {
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      } catch {
        // Referenced users are reported in dry-run and left intact unless manually cleaned.
      }
    }
  }
}

function applyConfig(db: Database.Database, config: BootstrapConfig): void {
  const tx = db.transaction(() => {
    for (const agent of config.agents) upsertAgent(db, agent);
    for (const agent of config.agents) upsertMembers(db, agent);
    removeUnlistedTargetMembers(db, config);
    for (const bot of config.weworkBots) {
      const agent = db.prepare('SELECT id FROM agents WHERE name = ?').get(bot.agent) as { id: string } | undefined;
      if (!agent) throw new Error(`企微 bot 绑定了未知 agent: ${bot.agent}`);
      upsertBot(db, bot);
      upsertAssignment(db, bot, agent.id);
    }
    removeUnlistedRuntimeRows(db, config);
  });
  tx();
}

function exportCurrentConfig(db: Database.Database, outputPath: string): void {
  const agents = db.prepare(`
    SELECT id, name, display_name, description, model, provider, tools_mode,
           tools_list, block_tools, user_tools_mode, user_tools_list, max_history
    FROM agents
    WHERE name IN ('ticlaw', 'otcclaw')
    ORDER BY CASE name WHEN 'admin' THEN 1 WHEN 'ticlaw' THEN 2 WHEN 'otcclaw' THEN 3 ELSE 4 END
  `).all() as any[];
  const members = db.prepare(`
    SELECT a.name AS agent, u.id AS user, am.role
    FROM agent_members am
    JOIN agents a ON a.id = am.agent_id
    JOIN users u ON u.id = am.user_id
    WHERE a.name IN ('ticlaw', 'otcclaw')
    ORDER BY a.name, u.id
  `).all() as Array<{ agent: string; user: string; role: MemberRole }>;
  const bots = db.prepare(`
    SELECT ba.id, ba.name, ba.secret, ba.show_thinking, ba.auto_start, ba.config, a.name AS agent
    FROM bot_apps ba
    JOIN agent_assignments aa ON aa.app_id = ba.id AND aa.channel = 'wework'
    JOIN agents a ON a.id = aa.agent_id
    WHERE ba.channel = 'wework' AND a.name IN ('admin', 'ticlaw', 'otcclaw')
    ORDER BY a.name, ba.name
  `).all() as any[];

  const exported: BootstrapConfig = {
    users: { keep: ['admin-001'], keepPrefixes: ['wework_', 'wework_user_'], removeNonWework: false },
    agents: agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      displayName: agent.display_name,
      description: agent.description ?? undefined,
      model: agent.model ?? undefined,
      provider: agent.provider ?? undefined,
      toolsMode: agent.tools_mode,
      toolsList: parseJsonList(agent.tools_list),
      blockTools: parseJsonList(agent.block_tools),
      userToolsMode: agent.user_tools_mode ?? 'inherit',
      userToolsList: parseJsonList(agent.user_tools_list),
      maxHistory: agent.max_history ?? 80,
      members: members.filter(member => member.agent === agent.name).map(member => ({ user: member.user, role: member.role })),
    })),
    weworkBots: bots.map(bot => ({
      id: bot.id,
      name: bot.name,
      agent: bot.agent,
      secret: maskSecret(bot.secret),
      showThinking: bot.show_thinking !== 0,
      autoStart: bot.auto_start !== 0,
      config: bot.config ? JSON.parse(bot.config) : {},
    })),
    cleanup: {
      removeNonTargetAgents: true,
      removeAgents: [],
      removeNonWeworkAssignments: true,
      removeUnlistedWeworkBots: false,
    },
  };

  const target = resolve(process.cwd(), outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(exported, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.exportCurrent) {
    const db = openReadonlyDb();
    exportCurrentConfig(db, options.exportCurrent);
    db.close();
    console.log(`已导出当前生产 bootstrap 配置: ${options.exportCurrent}`);
    return;
  }

  if (!options.config) throw new Error('缺少 --config');
  const config = readConfig(options.config);
  validateConfig(config, options.apply);

  if (!options.apply) {
    const db = openReadonlyDb();
    const plan = {
      mode: 'dry-run',
      agents: config.agents.map(agent => ({
        name: agent.name,
        id: agent.id,
        toolsMode: agent.toolsMode,
        tools: agent.toolsList.length,
        blockTools: agent.blockTools.length,
        userToolsMode: agent.userToolsMode,
        userTools: agent.userToolsList.length,
        members: agent.members.length,
      })),
      weworkBots: config.weworkBots.map(bot => ({
        id: bot.id,
        name: bot.name,
        agent: bot.agent,
        secret: maskSecret(bot.secret),
        autoStart: bot.autoStart !== false,
      })),
      cleanup: cleanupCandidates(db, config),
    };
    db.close();
    if (options.json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log('[dry-run] production bootstrap plan');
      console.log(JSON.stringify(plan, null, 2));
    }
    return;
  }

  const backupPath = await backupDatabase();
  await initDatabase();
  const db = getDb();
  applyConfig(db, config);
  db.pragma('wal_checkpoint(TRUNCATE)');
  if (options.json) {
    console.log(JSON.stringify({ success: true, backupPath }, null, 2));
  } else {
    console.log('生产 bootstrap 已应用');
    if (backupPath) console.log(`备份: ${backupPath}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => {
  closeDb();
});
