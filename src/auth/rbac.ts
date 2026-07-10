import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { v4 as uuid } from 'uuid';
import { getExecutionChannel, getContextUser } from '../runtime/execution-context.js';

export type Role = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  role: Role;
  display_name?: string;
}

export interface UserListRow extends User {
  alias_count: number;
  created_at: string;
}

export interface UserAlias {
  alias_user_id: string;
  canonical_user_id: string;
  note?: string;
  created_at: string;
}

export type IdentityPlatform = 'feishu' | 'wework' | string;

export interface ExternalIdentityIds {
  union_id?: string;
  unionId?: string;
  user_id?: string;
  userId?: string;
  open_id?: string;
  openId?: string;
  userid?: string;
  rawId?: string;
  legacyId?: string;
}

export interface ExternalUserResolution {
  user: User;
  created: boolean;
  canonicalUserId: string;
  aliasIds: string[];
  rawUserId?: string;
}

let fallbackUser: User | null = null;

export function setCurrentUser(user: User): void {
  fallbackUser = user;
}

export function getCurrentUser(): User {
  const ctxUser = getContextUser();
  if (ctxUser) return ctxUser as User;
  if (fallbackUser) return fallbackUser;
  throw new Error('未登录');
}

export function isAdmin(): boolean {
  return getCurrentUser().role === 'admin';
}

export function isSystemAdmin(): boolean {
  return getExecutionChannel() === 'cli' && isAdmin();
}

function firstId(...values: Array<string | undefined | null>): string | undefined {
  return values.find(v => typeof v === 'string' && v.length > 0) ?? undefined;
}

export function buildWeworkUserAliasId(rawUserId: string): string {
  return `wework_user_${rawUserId}`;
}

export function buildWeworkAutoUserId(rawUserId: string): string {
  const digest = createHash('sha256').update(rawUserId).digest('hex').slice(0, 12);
  return `user-wework-${digest}`;
}

export function buildCanonicalUserId(platform: IdentityPlatform, ids: ExternalIdentityIds): string {
  if (platform === 'feishu') {
    const unionId = firstId(ids.union_id, ids.unionId);
    if (unionId) return `feishu_union_${unionId}`;
    const userId = firstId(ids.user_id, ids.userId);
    if (userId) return `feishu_user_${userId}`;
    const openId = firstId(ids.open_id, ids.openId);
    if (openId) return `feishu_open_${openId}`;
  }

  if (platform === 'wework') {
    const userId = firstId(ids.userid, ids.user_id, ids.userId, ids.rawId, ids.legacyId);
    if (userId) return buildWeworkAutoUserId(userId);
  }

  return firstId(ids.legacyId, ids.rawId, ids.user_id, ids.userId, ids.open_id, ids.openId, ids.userid, ids.union_id, ids.unionId)
    ?? `${platform}_unknown`;
}

function uniqueIds(values: Array<string | undefined | null>): string[] {
  return [...new Set(values
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(v => v.length > 0))];
}

export function collectExternalUserIds(platform: IdentityPlatform, ids: ExternalIdentityIds): string[] {
  if (platform === 'feishu') {
    const unionId = firstId(ids.union_id, ids.unionId);
    const userId = firstId(ids.user_id, ids.userId);
    const openId = firstId(ids.open_id, ids.openId, ids.rawId, ids.legacyId);
    return uniqueIds([
      buildCanonicalUserId(platform, ids),
      unionId ? `feishu_union_${unionId}` : undefined,
      userId ? `feishu_user_${userId}` : undefined,
      openId ? `feishu_open_${openId}` : undefined,
      unionId ? `feishu_${unionId}` : undefined,
      userId ? `feishu_${userId}` : undefined,
      openId ? `feishu_${openId}` : undefined,
      ids.legacyId,
      ids.rawId,
    ]);
  }

  if (platform === 'wework') {
    const raw = firstId(ids.userid, ids.user_id, ids.userId, ids.rawId);
    return uniqueIds([
      raw ? buildWeworkUserAliasId(raw) : undefined,
    ]);
  }

  return uniqueIds([buildCanonicalUserId(platform, ids), ids.legacyId, ids.rawId, ids.user_id, ids.userId, ids.open_id, ids.openId, ids.userid, ids.union_id, ids.unionId]);
}

export function resolveCanonicalUserId(userId: string): string {
  const db = getDb();
  let root = userId;
  const seen = new Set<string>([root]);
  try {
    for (let i = 0; i < 50; i++) {
      const row = db.prepare(
        'SELECT canonical_user_id FROM user_aliases WHERE alias_user_id = ?',
      ).get(root) as { canonical_user_id: string } | undefined;
      if (!row || seen.has(row.canonical_user_id)) break;
      root = row.canonical_user_id;
      seen.add(root);
    }
  } catch {
    return userId;
  }
  return root;
}

export function getUserByIdOrUsername(ref: string): User | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT id, username, role, display_name FROM users WHERE id = ? OR username = ? LIMIT 1',
  ).get(ref, ref) as User | undefined;
}

export function upsertUserAlias(canonicalRef: string, aliasUserId: string, note?: string): UserAlias {
  const canonical = getUserByIdOrUsername(canonicalRef);
  if (!canonical) throw new Error(`用户不存在: ${canonicalRef}`);
  const alias = aliasUserId.trim();
  if (!alias) throw new Error('alias_user_id 不能为空');
  if (alias === canonical.id) throw new Error('alias_user_id 不能等于 canonical_user_id');

  const db = getDb();
  db.prepare(`
    INSERT INTO user_aliases (alias_user_id, canonical_user_id, note)
    VALUES (?, ?, ?)
    ON CONFLICT(alias_user_id) DO UPDATE SET
      canonical_user_id = excluded.canonical_user_id,
      note = excluded.note
  `).run(alias, canonical.id, note ?? null);

  return db.prepare(
    'SELECT alias_user_id, canonical_user_id, note, created_at FROM user_aliases WHERE alias_user_id = ?',
  ).get(alias) as UserAlias;
}

export function deleteUserAlias(aliasUserId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM user_aliases WHERE alias_user_id = ?').run(aliasUserId);
  return result.changes > 0;
}

export function listUserAliases(userRef: string): UserAlias[] {
  const db = getDb();
  const byUsername = db.prepare(
    'SELECT id, username, role, display_name FROM users WHERE username = ? LIMIT 1',
  ).get(userRef) as User | undefined;
  const root = byUsername ? byUsername.id : resolveCanonicalUserId(userRef);
  const canonical = getUser(root) ?? getUser(userRef);
  const canonicalId = canonical?.id ?? root;
  return db.prepare(
    'SELECT alias_user_id, canonical_user_id, note, created_at FROM user_aliases WHERE canonical_user_id = ? ORDER BY created_at DESC, alias_user_id',
  ).all(canonicalId) as UserAlias[];
}

export function registerUserAliases(canonicalUserId: string, aliases: string[], note?: string): void {
  if (!canonicalUserId) return;
  const db = getDb();
  try {
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(canonicalUserId);
    if (!exists) return;
    const ins = db.prepare(
      'INSERT OR IGNORE INTO user_aliases (alias_user_id, canonical_user_id, note) VALUES (?, ?, ?)',
    );
    for (const alias of [...new Set(aliases.filter(Boolean))]) {
      if (alias === canonicalUserId) continue;
      ins.run(alias, canonicalUserId, note ?? null);
    }
  } catch {
    // Older databases may not have user_aliases yet; identity still works with the canonical id.
  }
}

export function resolveExternalUser(
  platform: IdentityPlatform,
  ids: ExternalIdentityIds,
  fallbackName?: string,
  displayName?: string,
): User {
  return resolveExternalUserWithStatus(platform, ids, fallbackName, displayName).user;
}

export function resolveExternalUserWithStatus(
  platform: IdentityPlatform,
  ids: ExternalIdentityIds,
  fallbackName?: string,
  displayName?: string,
): ExternalUserResolution {
  const canonicalCandidate = buildCanonicalUserId(platform, ids);
  const allIds = collectExternalUserIds(platform, ids);
  const rawUserId = platform === 'wework'
    ? firstId(ids.userid, ids.user_id, ids.userId, ids.rawId, ids.legacyId)
    : undefined;

  for (const id of allIds) {
    const root = resolveCanonicalUserId(id);
    if (root === id) continue;
    const user = getUser(root);
    if (user) {
      registerUserAliases(user.id, allIds, `${platform} sender identity`);
      return {
        user,
        created: false,
        canonicalUserId: user.id,
        aliasIds: allIds,
        rawUserId,
      };
    }
  }

  const existingCanonical = getUser(canonicalCandidate);
  if (existingCanonical) {
    registerUserAliases(existingCanonical.id, allIds, `${platform} sender identity`);
    return {
      user: existingCanonical,
      created: false,
      canonicalUserId: existingCanonical.id,
      aliasIds: allIds,
      rawUserId,
    };
  }

  const legacyUser = allIds.map(id => getUser(id)).find(Boolean);
  const username = fallbackName?.trim() || legacyUser?.username || canonicalCandidate;
  const created = !getUser(canonicalCandidate);
  const user = getOrCreateUser(canonicalCandidate, username, 'user', displayName ?? legacyUser?.display_name);
  registerUserAliases(user.id, allIds, `${platform} sender identity`);
  return {
    user,
    created,
    canonicalUserId: user.id,
    aliasIds: allIds,
    rawUserId,
  };
}

export function resolveUserScopeIds(userId?: string): string[] {
  if (!userId) return [];
  const db = getDb();
  try {
    const root = resolveCanonicalUserId(userId);

    const resolved = new Set<string>([root]);
    const queue = [root];
    while (queue.length > 0 && resolved.size < 200) {
      const current = queue.shift()!;
      const rows = db.prepare(
        'SELECT alias_user_id FROM user_aliases WHERE canonical_user_id = ?',
      ).all(current) as { alias_user_id: string }[];
      for (const row of rows) {
        if (resolved.has(row.alias_user_id)) continue;
        resolved.add(row.alias_user_id);
        queue.push(row.alias_user_id);
      }
    }

    resolved.add(userId);
    return [...resolved];
  } catch {
    return [userId];
  }
}

export function getAgentMembershipRole(agentId: string): Role | null {
  const user = getCurrentUser();
  const db = getDb();
  const userIds = resolveUserScopeIds(user.id);
  const placeholders = userIds.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT role FROM agent_members WHERE agent_id = ? AND user_id IN (${placeholders})`,
  ).all(agentId, ...userIds) as { role: Role }[];
  if (rows.some(r => r.role === 'admin')) return 'admin';
  return rows[0]?.role ?? null;
}

export function isAgentAdmin(agentId: string): boolean {
  if (isSystemAdmin()) return true;
  return getAgentMembershipRole(agentId) === 'admin';
}

export function isAgentMember(agentId: string): boolean {
  if (isSystemAdmin()) return true;
  return getAgentMembershipRole(agentId) !== null;
}

export function requireAdmin(): void {
  if (!isSystemAdmin()) {
    throw new Error('权限不足：需要系统管理员权限');
  }
}

export function requireAgentAdmin(agentId: string): void {
  if (!isAgentAdmin(agentId)) {
    throw new Error('权限不足：需要该 Agent 的管理员权限');
  }
}

export function getAllUsers(): User[] {
  const db = getDb();
  return db.prepare('SELECT id, username, role, display_name FROM users').all() as User[];
}

export function getAllUsersWithAliasCount(): UserListRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT u.id, u.username, u.role, u.display_name, u.created_at, COUNT(ua.alias_user_id) AS alias_count
    FROM users u
    LEFT JOIN user_aliases ua ON ua.canonical_user_id = u.id
    GROUP BY u.id, u.username, u.role, u.display_name, u.created_at
    ORDER BY u.created_at DESC, u.username ASC
  `).all() as UserListRow[];
}

export function getUser(id: string): User | undefined {
  const db = getDb();
  return db.prepare('SELECT id, username, role, display_name FROM users WHERE id = ?').get(id) as User | undefined;
}

function resolveUniqueUsername(db: any, username: string, selfId: string): string {
  const conflict = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, selfId);
  if (!conflict) return username;
  const suffix = selfId.slice(-4);
  return `${username}_${suffix}`;
}

export function getOrCreateUser(id: string, username: string, role: Role = 'user', displayName?: string): User {
  const db = getDb();
  const existing = getUser(id);
  if (existing) {
    let changed = false;
    let newUsername = existing.username;
    let newDisplayName = existing.display_name;

    if (existing.username !== username) {
      newUsername = resolveUniqueUsername(db, username, id);
      changed = true;
    }
    if (displayName && displayName !== existing.display_name) {
      newDisplayName = displayName;
      changed = true;
    }

    if (changed) {
      db.prepare('UPDATE users SET username = ?, display_name = ? WHERE id = ?')
        .run(newUsername, newDisplayName ?? null, id);
      return { ...existing, username: newUsername, display_name: newDisplayName };
    }
    return existing;
  }

  const unique = resolveUniqueUsername(db, username, id);
  db.prepare('INSERT INTO users (id, username, role, display_name) VALUES (?, ?, ?, ?)')
    .run(id, unique, role, displayName ?? null);
  return { id, username: unique, role, display_name: displayName };
}

export function createUser(username: string, role: Role = 'user', displayName?: string): User {
  const db = getDb();
  
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    throw new Error(`用户已存在: ${username}`);
  }

  const id = uuid();
  db.prepare('INSERT INTO users (id, username, role, display_name) VALUES (?, ?, ?, ?)').run(id, username, role, displayName ?? null);
  return { id, username, role, display_name: displayName };
}

export function updateUser(id: string, updates: Partial<Pick<User, 'username' | 'role' | 'display_name'>>): User {
  const db = getDb();
  const user = getUser(id);
  if (!user) {
    throw new Error(`用户不存在: ${id}`);
  }

  if (updates.username && updates.username !== user.username) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(updates.username);
    if (existing) {
      throw new Error(`用户名已被占用: ${updates.username}`);
    }
  }

  const newUsername = updates.username || user.username;
  const newRole = updates.role || user.role;
  const newDisplayName = Object.prototype.hasOwnProperty.call(updates, 'display_name')
    ? updates.display_name
    : user.display_name;

  db.prepare('UPDATE users SET username = ?, role = ?, display_name = ? WHERE id = ?').run(newUsername, newRole, newDisplayName ?? null, id);
  return { id, username: newUsername, role: newRole, display_name: newDisplayName };
}

export function deleteUser(id: string): void {
  const db = getDb();
  const user = getUser(id);
  if (!user) {
    throw new Error(`用户不存在: ${id}`);
  }
  
  if (user.role === 'admin') {
    // 检查是否是最后一个 admin
    const admins = db.prepare("SELECT count(*) as count FROM users WHERE role = 'admin'").get() as { count: number };
    if (admins.count <= 1) {
      throw new Error('不能删除系统中最后一个管理员');
    }
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
