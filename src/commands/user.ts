import { requireAdmin, getAllUsers, createUser, updateUser, deleteUser, Role } from '../auth/rbac.js';
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
  log.print('  user list                   列出所有用户');
  log.print('  user add <username> [role]  添加新用户 (role: admin 或 user, 默认为 user)');
  log.print('  user update <id> <role>     修改用户角色 (role: admin 或 user)');
  log.print('  user delete <id>            删除用户');
}

function listUsers(): void {
  const users = getAllUsers();
  const rows = users.map(u => [u.id, u.username, u.role]);
  
  log.print('\n【用户列表】');
  log.print(renderTable(['ID', '用户名', '角色'], rows));
}

async function addUser(args: string): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length < 1) {
    log.print('用法: /user add <username> [role]');
    return;
  }
  
  const username = parts[0];
  const role = (parts[1] === 'admin' ? 'admin' : 'user') as Role;
  
  const user = createUser(username, role);
  log.print(`✅ 用户创建成功: ${user.username} (ID: ${user.id}, 角色: ${user.role})`);
}

async function editUser(args: string): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    log.print('用法: /user update <id> <role>');
    return;
  }
  
  const id = parts[0];
  const role = parts[1] as Role;
  if (role !== 'admin' && role !== 'user') {
    throw new Error('角色必须为 admin 或 user');
  }
  
  const user = updateUser(id, { role });
  log.print(`✅ 用户更新成功: ${user.username} (角色: ${user.role})`);
}

async function removeUser(args: string): Promise<void> {
  if (!args) {
    log.print('用法: /user delete <id>');
    return;
  }
  
  deleteUser(args);
  log.print(`✅ 用户已删除: ${args}`);
}
