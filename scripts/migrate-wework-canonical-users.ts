#!/usr/bin/env npx tsx
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type Role = 'admin' | 'user';

interface CliOptions {
  apply: boolean;
  dbPath: string;
  json: boolean;
  help: boolean;
}

interface UserRow {
  id: string;
  username: string;
  role: Role;
  display_name: string | null;
}

interface CanonicalSpec {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
}

interface ReferenceColumn {
  table: string;
  column: string;
  hasForeignKey: boolean;
}

interface ForeignKeyViolation {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

const DEFAULT_DB_PATH = '/opt/samata/data/samata.db';

const DISPLAY_NAME_CANONICAL: Record<string, { id: string; username: string }> = {
  'April Yan': { id: 'user-aprilyan', username: 'aprilyan' },
  'Kevin Yin': { id: 'user-kevinyin', username: 'kevinyin' },
  'Nicolas Song': { id: 'user-nicolasong', username: 'nicolasong' },
  'Nicole Qiu': { id: 'user-nicoleqiu', username: 'nicoleqiu' },
  'Peter Shen': { id: 'user-petershen', username: 'petershen' },
  'Steven Lu': { id: 'user-stevenlu', username: 'stevenlu' },
  '刘航伸': { id: 'user-liuhangshen', username: 'liuhangshen' },
  '单楚文': { id: 'user-shanchuwen', username: 'shanchuwen' },
  '吕若楠': { id: 'user-lvruonan', username: 'lvruonan' },
  '唐洋': { id: 'user-tangyang', username: 'tangyang' },
  '孙娴': { id: 'user-sunxian', username: 'sunxian' },
  '孙滨': { id: 'user-sunbin', username: 'sunbin' },
  '杨易歌': { id: 'user-hkyangyige', username: 'hkyangyige' },
  '栾宜男': { id: 'user-luanyinan', username: 'luanyinan' },
  '熊周桥': { id: 'user-xiongzhouqiao', username: 'xiongzhouqiao' },
  '王兴强': { id: 'user-wangxingqiang', username: 'wangxingqiang' },
  '由嘉坤': { id: 'user-jiakunyou', username: 'jiakunyou' },
  '符航睿': { id: 'user-fuhangrui', username: 'fuhangrui' },
  '董胜利': { id: 'user-dongshengli', username: 'dongshengli' },
  '许骏': { id: 'user-gzxujun', username: 'gzxujun' },
  '赵晴宇': { id: 'user-zhaoqingyu', username: 'zhaoqingyu' },
  '郁泱': { id: 'user-gzyuyang', username: 'gzyuyang' },
  '郭晓瑜': { id: 'user-guoxiaoyu', username: 'guoxiaoyu' },
  '郭智': { id: 'user-gfguozhi', username: 'gfguozhi' },
  '陈婉茜': { id: 'user-chenwanqian', username: 'chenwanqian' },
  '黄伟琨': { id: 'user-weikunhuang', username: 'weikunhuang' },
  '黄晓怡': { id: 'user-huangxiaoyi', username: 'huangxiaoyi' },
};

const FK_REFERENCE_COLUMNS: ReferenceColumn[] = [
  { table: 'clients', column: 'created_by', hasForeignKey: true },
  { table: 'documents', column: 'created_by', hasForeignKey: true },
  { table: 'events', column: 'performed_by', hasForeignKey: true },
  { table: 'knowledge', column: 'created_by', hasForeignKey: true },
  { table: 'memory', column: 'created_by', hasForeignKey: true },
  { table: 'pricing_quotes', column: 'created_by', hasForeignKey: true },
  { table: 'skills', column: 'created_by', hasForeignKey: true },
  { table: 'todos', column: 'user_id', hasForeignKey: true },
  { table: 'wrong_questions', column: 'user_id', hasForeignKey: true },
  { table: 'wrong_questions', column: 'created_by', hasForeignKey: true },
];

const LOOSE_REFERENCE_COLUMNS: ReferenceColumn[] = [
  { table: 'agents', column: 'created_by', hasForeignKey: false },
  { table: 'answer_feedback', column: 'user_id', hasForeignKey: false },
  { table: 'answer_feedback', column: 'clicked_by_user_id', hasForeignKey: false },
  { table: 'scheduled_tasks', column: 'created_by', hasForeignKey: false },
  { table: 'telemetry_turn', column: 'user_id', hasForeignKey: false },
];

const AGENT_MEMBER_REFERENCE: ReferenceColumn = { table: 'agent_members', column: 'user_id', hasForeignKey: true };

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    dbPath: process.env.SAMATA_DB_PATH || DEFAULT_DB_PATH,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要参数`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--db') options.dbPath = next();
    else if (arg === '--json') options.json = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function printHelp(): void {
  console.log(`用法:
  npx tsx scripts/migrate-wework-canonical-users.ts --dry-run
  npx tsx scripts/migrate-wework-canonical-users.ts --apply
  npx tsx scripts/migrate-wework-canonical-users.ts --db /opt/samata/data/samata.db --dry-run

说明:
  默认 dry-run，只输出计划，不写数据库。
  --apply 会在事务中迁移，并先备份 SQLite。`);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function hashRaw(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

function buildAutoUserId(raw: string): string {
  return `user-wework-${hashRaw(raw)}`;
}

function rawFromWeworkUserId(id: string): string | null {
  if (id.startsWith('wework_user_')) return id.slice('wework_user_'.length);
  if (id.startsWith('wework_')) return id.slice('wework_'.length);
  return null;
}

function aliasForRaw(raw: string): string {
  return `wework_user_${raw}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function maxRole(a: Role, b: Role): Role {
  return a === 'admin' || b === 'admin' ? 'admin' : 'user';
}

function getCanonicalBase(user: UserRow, raw: string): { id: string; username: string; displayName: string | null } {
  if (user.display_name && DISPLAY_NAME_CANONICAL[user.display_name]) {
    return {
      ...DISPLAY_NAME_CANONICAL[user.display_name],
      displayName: user.display_name,
    };
  }
  return {
    id: buildAutoUserId(raw),
    username: `wework_${raw.slice(-6)}`,
    displayName: user.display_name,
  };
}

function resolveUniqueUsername(db: Database.Database, username: string, selfId: string): string {
  const row = db.prepare('SELECT id FROM users WHERE username = ? AND id != ? LIMIT 1').get(username, selfId) as { id: string } | undefined;
  if (!row) return username;
  return `${username}_${selfId.slice(-4)}`;
}

function collectPlan(db: Database.Database) {
  const referenceColumns = [...FK_REFERENCE_COLUMNS, ...LOOSE_REFERENCE_COLUMNS]
    .filter(ref => tableHasColumn(db, ref.table, ref.column));
  const oldUsers = collectHistoricalWeworkUsers(db, referenceColumns);

  const oldToCanonical = new Map<string, string>();
  const rawToCanonical = new Map<string, string>();
  const canonical = new Map<string, CanonicalSpec>();
  const aliasRows = new Map<string, { alias: string; canonicalId: string; raw: string }>();
  const unmappedOldIds: string[] = [];

  for (const user of oldUsers) {
    const raw = rawFromWeworkUserId(user.id);
    if (!raw) {
      unmappedOldIds.push(user.id);
      continue;
    }
    const base = getCanonicalBase(user, raw);
    const existing = canonical.get(base.id);
    canonical.set(base.id, {
      id: base.id,
      username: existing?.username ?? resolveUniqueUsername(db, base.username, base.id),
      displayName: existing?.displayName ?? base.displayName,
      role: existing ? maxRole(existing.role, user.role) : user.role,
    });
    oldToCanonical.set(user.id, base.id);
    const existingRaw = rawToCanonical.get(raw);
    if (existingRaw && existingRaw !== base.id) {
      throw new Error(`raw userid 映射冲突: ${raw} -> ${existingRaw} / ${base.id}`);
    }
    rawToCanonical.set(raw, base.id);
    aliasRows.set(aliasForRaw(raw), { alias: aliasForRaw(raw), canonicalId: base.id, raw });
  }

  const oldIds = [...oldToCanonical.keys()];
  const referenceUpdates = referenceColumns.map(ref => {
    let count = 0;
    for (const oldId of oldIds) {
      const row = db.prepare(`SELECT count(*) AS count FROM ${quoteIdent(ref.table)} WHERE ${quoteIdent(ref.column)} = ?`).get(oldId) as { count: number };
      count += row.count;
    }
    return { ...ref, count };
  }).filter(ref => ref.count > 0);

  const oldAgentMembers = db.prepare(`
    SELECT am.id, am.agent_id, a.name AS agent_name, am.user_id, am.role, am.created_at
    FROM agent_members am
    LEFT JOIN agents a ON a.id = am.agent_id
    WHERE am.user_id LIKE 'wework_%' OR am.user_id LIKE 'wework_user_%'
    ORDER BY a.name, am.user_id
  `).all() as Array<{ id: string; agent_id: string; agent_name: string | null; user_id: string; role: Role; created_at: string }>;

  const mergedAgentMembers = new Map<string, { agentId: string; agentName: string | null; canonicalId: string; role: Role; oldUserIds: string[]; createdAt: string }>();
  for (const row of oldAgentMembers) {
    const canonicalId = oldToCanonical.get(row.user_id);
    if (!canonicalId) continue;
    const key = `${row.agent_id}:${canonicalId}`;
    const existing = mergedAgentMembers.get(key);
    mergedAgentMembers.set(key, {
      agentId: row.agent_id,
      agentName: row.agent_name,
      canonicalId,
      role: existing ? maxRole(existing.role, row.role) : row.role,
      oldUserIds: unique([...(existing?.oldUserIds ?? []), row.user_id]),
      createdAt: existing?.createdAt ?? row.created_at,
    });
  }

  return {
    oldUsers,
    oldIds,
    oldToCanonical,
    canonicalUsers: [...canonical.values()].sort((a, b) => a.id.localeCompare(b.id)),
    aliasRows: [...aliasRows.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
    oldAgentMembers,
    mergedAgentMembers: [...mergedAgentMembers.values()].sort((a, b) => `${a.agentName}:${a.canonicalId}`.localeCompare(`${b.agentName}:${b.canonicalId}`)),
    referenceUpdates,
    unmappedOldIds,
  };
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>;
  return columns.some(item => item.name === column);
}

function collectDistinctWeworkIds(db: Database.Database, ref: ReferenceColumn): string[] {
  if (!tableHasColumn(db, ref.table, ref.column)) return [];
  const rows = db.prepare(`
    SELECT DISTINCT ${quoteIdent(ref.column)} AS id
    FROM ${quoteIdent(ref.table)}
    WHERE ${quoteIdent(ref.column)} LIKE 'wework_%'
       OR ${quoteIdent(ref.column)} LIKE 'wework_user_%'
  `).all() as Array<{ id: string | null }>;
  return rows.map(row => row.id).filter((id): id is string => Boolean(id && rawFromWeworkUserId(id)));
}

function collectHistoricalWeworkUsers(db: Database.Database, referenceColumns: ReferenceColumn[]): UserRow[] {
  const rows = db.prepare(`
    SELECT id, username, role, display_name
    FROM users
    WHERE id LIKE 'wework_%' OR id LIKE 'wework_user_%'
    ORDER BY display_name IS NULL, display_name, id
  `).all() as UserRow[];
  const usersById = new Map(rows.map(row => [row.id, row]));

  const orphanIds = unique([
    ...referenceColumns.flatMap(ref => collectDistinctWeworkIds(db, ref)),
    ...collectDistinctWeworkIds(db, AGENT_MEMBER_REFERENCE),
  ]);
  for (const id of orphanIds) {
    if (usersById.has(id)) continue;
    const raw = rawFromWeworkUserId(id);
    if (!raw) continue;
    usersById.set(id, {
      id,
      username: `wework_${raw.slice(-6)}`,
      role: 'user',
      display_name: null,
    });
  }

  return [...usersById.values()].sort((a, b) => {
    const displayOrder = Number(a.display_name === null) - Number(b.display_name === null);
    if (displayOrder !== 0) return displayOrder;
    return `${a.display_name ?? ''}:${a.id}`.localeCompare(`${b.display_name ?? ''}:${b.id}`);
  });
}

async function backupDatabase(dbPath: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupPath = resolve(dirname(dbPath), `backups/wework-canonical-users-${timestamp}/samata.db`);
  mkdirSync(dirname(backupPath), { recursive: true });
  const readonly = new Database(dbPath, { readonly: true, fileMustExist: true });
  await readonly.backup(backupPath);
  readonly.close();
  return backupPath;
}

function insertOrUpdateCanonicalUser(db: Database.Database, spec: CanonicalSpec): void {
  db.prepare(`
    INSERT INTO users (id, username, role, display_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      role = CASE WHEN users.role = 'admin' OR excluded.role = 'admin' THEN 'admin' ELSE excluded.role END,
      display_name = COALESCE(users.display_name, excluded.display_name)
  `).run(spec.id, spec.username, spec.role, spec.displayName);
}

function updateReferences(db: Database.Database, oldToCanonical: Map<string, string>): void {
  const refs = [...FK_REFERENCE_COLUMNS, ...LOOSE_REFERENCE_COLUMNS]
    .filter(ref => tableHasColumn(db, ref.table, ref.column));
  for (const ref of refs) {
    const stmt = db.prepare(`UPDATE ${quoteIdent(ref.table)} SET ${quoteIdent(ref.column)} = ? WHERE ${quoteIdent(ref.column)} = ?`);
    for (const [oldId, canonicalId] of oldToCanonical) stmt.run(canonicalId, oldId);
  }
}

function migrateAgentMembers(db: Database.Database, plan: ReturnType<typeof collectPlan>): void {
  const insert = db.prepare(`
    INSERT INTO agent_members (id, agent_id, user_id, role, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, user_id) DO UPDATE SET
      role = CASE WHEN agent_members.role = 'admin' OR excluded.role = 'admin' THEN 'admin' ELSE excluded.role END
  `);
  for (const item of plan.mergedAgentMembers) {
    insert.run(`wework-canonical-${item.agentId}-${item.canonicalId}`, item.agentId, item.canonicalId, item.role, item.createdAt);
  }
  for (const oldId of plan.oldIds) {
    db.prepare('DELETE FROM agent_members WHERE user_id = ?').run(oldId);
  }
}

function migrateAliases(db: Database.Database, plan: ReturnType<typeof collectPlan>): void {
  for (const oldId of plan.oldIds) {
    db.prepare('DELETE FROM user_aliases WHERE alias_user_id = ? OR canonical_user_id = ?').run(oldId, oldId);
  }
  const insert = db.prepare(`
    INSERT INTO user_aliases (alias_user_id, canonical_user_id, note)
    VALUES (?, ?, ?)
    ON CONFLICT(alias_user_id) DO UPDATE SET
      canonical_user_id = excluded.canonical_user_id,
      note = excluded.note
  `);
  for (const row of plan.aliasRows) {
    insert.run(row.alias, row.canonicalId, 'wework canonical migration');
  }
}

function deleteOldUsers(db: Database.Database, oldIds: string[]): void {
  const stmt = db.prepare('DELETE FROM users WHERE id = ?');
  for (const oldId of oldIds) stmt.run(oldId);
}

function getForeignKeyViolations(db: Database.Database): ForeignKeyViolation[] {
  return db.prepare('PRAGMA foreign_key_check').all() as ForeignKeyViolation[];
}

function foreignKeyViolationKey(row: ForeignKeyViolation): string {
  return `${row.table}:${row.rowid}:${row.parent}:${row.fkid}`;
}

function findNewForeignKeyViolations(before: ForeignKeyViolation[], after: ForeignKeyViolation[]): ForeignKeyViolation[] {
  const beforeKeys = new Set(before.map(foreignKeyViolationKey));
  return after.filter(row => !beforeKeys.has(foreignKeyViolationKey(row)));
}

function applyPlan(db: Database.Database, plan: ReturnType<typeof collectPlan>, baselineFkViolations: ForeignKeyViolation[]): void {
  const tx = db.transaction(() => {
    for (const spec of plan.canonicalUsers) insertOrUpdateCanonicalUser(db, spec);
    migrateAgentMembers(db, plan);
    updateReferences(db, plan.oldToCanonical);
    migrateAliases(db, plan);
    deleteOldUsers(db, plan.oldIds);
    const fkRows = getForeignKeyViolations(db);
    const newFkRows = findNewForeignKeyViolations(baselineFkViolations, fkRows);
    if (newFkRows.length > 0) throw new Error(`foreign_key_check introduced new failures: ${JSON.stringify(newFkRows)}`);
  });
  tx();
}

function summarize(db: Database.Database, plan: ReturnType<typeof collectPlan>) {
  const oldUsersByCanonical = plan.canonicalUsers.map(user => ({
    canonical: user,
    oldIds: [...plan.oldToCanonical.entries()].filter(([, canonicalId]) => canonicalId === user.id).map(([oldId]) => oldId),
    aliases: plan.aliasRows.filter(row => row.canonicalId === user.id).map(row => row.alias),
  }));
  const remaining = {
    usersOldWework: (db.prepare("SELECT count(*) AS count FROM users WHERE id LIKE 'wework_%' OR id LIKE 'wework_user_%'").get() as { count: number }).count,
    agentMembersOldWework: (db.prepare("SELECT count(*) AS count FROM agent_members WHERE user_id LIKE 'wework_%' OR user_id LIKE 'wework_user_%'").get() as { count: number }).count,
    legacyAliases: (db.prepare("SELECT count(*) AS count FROM user_aliases WHERE alias_user_id LIKE 'wework_%' AND alias_user_id NOT LIKE 'wework_user_%'").get() as { count: number }).count,
  };
  return {
    oldUserCount: plan.oldUsers.length,
    canonicalUserCount: plan.canonicalUsers.length,
    aliasCount: plan.aliasRows.length,
    oldAgentMemberCount: plan.oldAgentMembers.length,
    mergedAgentMemberCount: plan.mergedAgentMembers.length,
    referenceUpdates: plan.referenceUpdates,
    unmappedOldIds: plan.unmappedOldIds,
    oldUsersByCanonical,
    mergedAgentMembers: plan.mergedAgentMembers,
    remaining,
  };
}

function printSummary(summary: ReturnType<typeof summarize>): void {
  console.log('企微 canonical 用户迁移 dry-run 结果');
  console.log(`旧 wework 用户: ${summary.oldUserCount}`);
  console.log(`将创建/更新 canonical 用户: ${summary.canonicalUserCount}`);
  console.log(`将创建/更新 current alias: ${summary.aliasCount}`);
  console.log(`旧 agent_members: ${summary.oldAgentMemberCount}`);
  console.log(`合并后 agent_members: ${summary.mergedAgentMemberCount}`);
  console.log('');

  console.log('Canonical 用户映射:');
  for (const item of summary.oldUsersByCanonical) {
    console.log(`- ${item.canonical.id} (${item.canonical.displayName ?? '-'})`);
    console.log(`  old: ${item.oldIds.join(', ')}`);
    console.log(`  alias: ${item.aliases.join(', ')}`);
  }
  console.log('');

  console.log('Agent 权限合并:');
  for (const item of summary.mergedAgentMembers) {
    console.log(`- ${item.agentName ?? item.agentId}: ${item.oldUserIds.join(', ')} -> ${item.canonicalId} (${item.role})`);
  }
  console.log('');

  console.log('历史引用更新:');
  for (const ref of summary.referenceUpdates) {
    console.log(`- ${ref.table}.${ref.column}: ${ref.count}`);
  }
  if (summary.referenceUpdates.length === 0) console.log('- 无');
  console.log('');

  if (summary.unmappedOldIds.length > 0) {
    console.log('未能映射的旧 ID:');
    for (const id of summary.unmappedOldIds) console.log(`- ${id}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const dbPath = resolve(options.dbPath);
  if (!existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  const db = new Database(dbPath, { readonly: !options.apply, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  try {
    const plan = collectPlan(db);
    const before = summarize(db, plan);
    if (options.json) {
      console.log(JSON.stringify(before, null, 2));
    } else {
      printSummary(before);
    }

    if (!options.apply) return;

    const baselineFkViolations = getForeignKeyViolations(db);
    const backupPath = await backupDatabase(dbPath);
    applyPlan(db, plan, baselineFkViolations);
    const afterPlan = collectPlan(db);
    const after = summarize(db, afterPlan);
    const remainingFkViolations = getForeignKeyViolations(db);
    console.log('');
    console.log(`已应用迁移，备份文件: ${backupPath}`);
    console.log(`剩余旧 users: ${after.remaining.usersOldWework}`);
    console.log(`剩余旧 agent_members: ${after.remaining.agentMembersOldWework}`);
    console.log(`剩余旧 alias: ${after.remaining.legacyAliases}`);
    console.log(`历史 FK 异常仍存在: ${remainingFkViolations.length}`);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
