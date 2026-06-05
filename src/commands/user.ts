import {
  requireAdmin,
  getAllUsersWithAliasCount,
  createUser,
  updateUser,
  deleteUser,
  deleteUserAlias,
  getUserByIdOrUsername,
  listUserAliases,
  upsertUserAlias,
  type Role,
} from '../auth/rbac.js';
import { log } from '../utils/logger.js';
import { renderTable } from '../utils/table.js';

export async function handleUser(args: string): Promise<void> {
  const match = args.match(/^(\S+)\s*(.*)/s);
  if (!match) {
    showHelp();
    return;
  }

  const sub = match[1].toLowerCase();
  const rest = match[2].trim();

  try {
    requireAdmin();
  } catch (err: any) {
    log.error(err.message);
    return;
  }

  try {
    switch (sub) {
      case 'list':
        listUsers();
        break;
      case 'add':
        await addUser(rest);
        break;
      case 'update':
        await editUser(rest);
        break;
      case 'alias':
        await handleAlias(rest);
        break;
      case 'del':
      case 'delete':
        await removeUser(rest);
        break;
      default:
        showHelp();
    }
  } catch (err: any) {
    log.error(`操作失败: ${err.message}`);
  }
}

function showHelp(): void {
  log.print('User 用法：');
  log.print('  user list                                            列出所有用户');
  log.print('  user add <username> [role] [display_name]            添加新用户');
  log.print('  user update <id|username> --username <name> --display-name <name> --role <role>');
  log.print('  user alias add <canonical_id|username> <alias_id> [note]');
  log.print('  user alias list <id|username>');
  log.print('  user alias del <alias_id>');
  log.print('  user delete <id|username>                            删除用户');
}

function listUsers(): void {
  const users = getAllUsersWithAliasCount();
  const rows = users.map(u => [u.id, u.username, u.display_name ?? '-', u.role, String(u.alias_count)]);
  
  log.print('\n【用户列表】');
  log.print(renderTable(['ID', '用户名', '显示名', '角色', 'Alias 数'], rows));
}

function tokenize(args: string): string[] {
  const matches = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map(token => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function parseOptions(args: string): { positionals: string[]; options: Record<string, string | true> } {
  const tokens = tokenize(args);
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eqIdx = token.indexOf('=');
    if (eqIdx > 2) {
      options[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      i++;
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
}

function asStringOption(value: string | true | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function addUser(args: string): Promise<void> {
  const parts = tokenize(args);
  if (parts.length < 1) {
    log.print('用法: /user add <username> [role] [display_name]');
    return;
  }
  
  const username = parts[0];
  const hasRole = parts[1] === 'admin' || parts[1] === 'user';
  const role = (hasRole ? parts[1] : 'user') as Role;
  const displayName = parts.slice(hasRole ? 2 : 1).join(' ') || undefined;
  
  const user = createUser(username, role, displayName);
  log.print(`✅ 用户创建成功: ${user.username} (ID: ${user.id}, 显示名: ${user.display_name ?? '-'}, 角色: ${user.role})`);
}

async function editUser(args: string): Promise<void> {
  const parsed = parseOptions(args);
  const ref = parsed.positionals[0];
  if (!ref) {
    log.print('用法: /user update <id|username> --username <name> --display-name <name> --role <role>');
    return;
  }

  const existing = getUserByIdOrUsername(ref);
  if (!existing) throw new Error(`用户不存在: ${ref}`);

  const updates: Parameters<typeof updateUser>[1] = {};
  const username = asStringOption(parsed.options.username);
  const displayName = asStringOption(parsed.options['display-name']);
  const role = asStringOption(parsed.options.role) ?? parsed.positionals[1];
  if (username) updates.username = username;
  if (displayName !== undefined) updates.display_name = displayName;
  if (role) {
    if (role !== 'admin' && role !== 'user') {
      throw new Error('角色必须为 admin 或 user');
    }
    updates.role = role;
  }
  if (Object.keys(updates).length === 0) {
    log.print('用法: /user update <id|username> --username <name> --display-name <name> --role <role>');
    return;
  }

  const user = updateUser(existing.id, updates);
  log.print(`✅ 用户更新成功: ${user.username} (ID: ${user.id}, 显示名: ${user.display_name ?? '-'}, 角色: ${user.role})`);
}

async function handleAlias(args: string): Promise<void> {
  const parsed = parseOptions(args);
  const action = (parsed.positionals[0] || '').toLowerCase();

  if (action === 'add') {
    const canonical = parsed.positionals[1];
    const alias = parsed.positionals[2];
    const note = parsed.positionals.slice(3).join(' ') || undefined;
    if (!canonical || !alias) {
      log.print('用法: /user alias add <canonical_id|username> <alias_id> [note]');
      return;
    }
    const row = upsertUserAlias(canonical, alias, note);
    log.print(`✅ Alias 已绑定: ${row.alias_user_id} -> ${row.canonical_user_id}`);
    return;
  }

  if (action === 'list') {
    const ref = parsed.positionals[1];
    if (!ref) {
      log.print('用法: /user alias list <id|username>');
      return;
    }
    const rows = listUserAliases(ref);
    log.print(`\n【用户 Alias: ${ref}】`);
    if (rows.length === 0) {
      log.print('无');
      return;
    }
    log.print(renderTable(
      ['Alias ID', 'Canonical ID', '备注', '创建时间'],
      rows.map(row => [row.alias_user_id, row.canonical_user_id, row.note ?? '-', row.created_at]),
    ));
    return;
  }

  if (action === 'del' || action === 'delete') {
    const alias = parsed.positionals[1];
    if (!alias) {
      log.print('用法: /user alias del <alias_id>');
      return;
    }
    const deleted = deleteUserAlias(alias);
    log.print(deleted ? `✅ Alias 已删除: ${alias}` : `未找到 Alias: ${alias}`);
    return;
  }

  log.print('用法: /user alias <add|list|del> ...');
}

async function removeUser(args: string): Promise<void> {
  const ref = args.trim();
  if (!ref) {
    log.print('用法: /user delete <id|username>');
    return;
  }

  const user = getUserByIdOrUsername(ref);
  if (!user) {
    throw new Error(`用户不存在: ${ref}`);
  }
  deleteUser(user.id);
  log.print(`✅ 用户已删除: ${user.username} (${user.id})`);
}
