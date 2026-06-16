import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { isSystemAdmin, isAgentAdmin } from '../auth/rbac.js';
import { getCurrentAgent } from '../llm/agents/config.js';
import { markReloadIfSource } from '../llm/reload.js';
import { getUploadDir } from '../commands/artifact.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd());
const FORBIDDEN_PATTERNS = ['.env', 'node_modules/', 'data/*.db', '.git/'];
const HIDDEN_DIRECTORY_NAMES = new Set(['.git', '.hg', '.svn', 'node_modules']);

const ALLOWLIST_DIR = path.join(process.cwd(), 'config', 'agents');
const allowlistCache = new Map<string, { mtimeMs: number; list: string[] | null }>();

/**
 * Load read_file allowlist for an agent from `config/agents/<name>.files.json`.
 * Returns `null` when the file does not exist (no agent-level restriction → fall back to system-admin gate).
 * Cached per file with mtime invalidation so edits take effect without restart.
 */
function loadAgentFileAllowlist(agentName: string): string[] | null {
  const file = path.join(ALLOWLIST_DIR, `${agentName}.files.json`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    allowlistCache.set(agentName, { mtimeMs: 0, list: null });
    return null;
  }
  const cached = allowlistCache.get(agentName);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.list;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(x => typeof x === 'string')) {
      throw new Error(`expected JSON array of strings`);
    }
    const list = parsed.map(p => p.replace(/^\/+/, ''));
    allowlistCache.set(agentName, { mtimeMs: stat.mtimeMs, list });
    return list;
  } catch (err: any) {
    console.warn(`[file-tools] invalid allowlist ${file}: ${err.message}`);
    allowlistCache.set(agentName, { mtimeMs: stat.mtimeMs, list: [] });
    return [];
  }
}

/**
 * Decide whether the current agent may read `inputPath` via `read_file`.
 * Returns the absolute path on success, or `{error}` describing why it was rejected.
 */
function isAllowlisted(relative: string, allowlist: string[]): boolean {
  const normalizedRelative = relative.replace(/\/+$/, '');
  return allowlist.some(entry => {
    const normalizedEntry = entry.replace(/^\/+/, '').replace(/\/+$/, '');
    if (entry.endsWith('/')) {
      return normalizedRelative === normalizedEntry || normalizedRelative.startsWith(normalizedEntry + '/');
    }
    return normalizedRelative === normalizedEntry;
  });
}

function authorizeRead(inputPath: string): { filePath: string; relative: string } | { error: string } {
  let filePath = inputPath.startsWith('~')
    ? inputPath.replace('~', process.env.HOME || '')
    : inputPath;
  if (!path.isAbsolute(filePath)) filePath = path.resolve(PROJECT_ROOT, filePath);
  filePath = path.normalize(filePath);

  const agent = getCurrentAgent();
  const agentName = agent?.name;

  // Agent can always read files from its own upload directory
  if (agentName) {
    const ownUploadDir = path.normalize(getUploadDir(agentName));
    if (filePath === ownUploadDir || filePath.startsWith(ownUploadDir + path.sep)) {
      return { filePath, relative: filePath };
    }
  }

  if (filePath !== PROJECT_ROOT && !filePath.startsWith(PROJECT_ROOT + path.sep)) {
    if (filePath.startsWith('/tmp/samata/')) {
      return {
        error: `read_file 拒绝：${inputPath} 是沙箱/临时目录路径。请改用 sandbox_read_file，并传入 sandbox_exec 返回的沙箱相对路径（不要传 /tmp 绝对路径）。`,
      };
    }
    return { error: `read_file 拒绝：路径不在项目目录内 (${inputPath})` };
  }
  const relative = filePath === PROJECT_ROOT ? '' : filePath.slice(PROJECT_ROOT.length + 1);

  const allowlist = agentName ? loadAgentFileAllowlist(agentName) : null;

  if (allowlist !== null) {
    if (!isAllowlisted(relative, allowlist)) {
      return {
        error: `read_file 拒绝：${relative} 不在 ${agentName} 的可读白名单内。可读列表：${JSON.stringify(allowlist)}（如需新增，请管理员编辑 config/agents/${agentName}.files.json）`,
      };
    }
    return { filePath, relative };
  }

  if (isSystemAdmin()) return { filePath, relative };

  return {
    error: `read_file 拒绝：${agentName ?? '当前 agent'} 没有配置可读白名单 (config/agents/${agentName ?? '<name>'}.files.json)，且当前用户不是系统管理员`,
  };
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'list_directory',
    description: '列出指定目录下的文件和子目录',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '目录路径（绝对路径或相对路径）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: '读取项目内文件内容。受 agent 白名单约束：只能读取 config/agents/<agent>.files.json 中列出的文件路径（相对项目根，精确匹配）；白名单未配置时仅系统管理员可调。被拒时错误信息会附完整可读列表。',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '文件路径（相对项目根或绝对路径），必须命中当前 agent 的白名单' },
        max_lines: { type: 'number', description: '最多读取行数，默认500' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '写入文件内容（仅限项目目录内，仅管理员可用）。用于项目内源码或数据文件；若要生成待发送给用户的临时附件，请使用 write_artifact。修改已有文件请优先使用 edit_file。',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '文件路径（相对于项目根目录或绝对路径）' },
        content: { type: 'string', description: '要写入的文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: '搜索并替换文件中的指定内容（仅限项目目录内，仅管理员可用）。适合对已有文件做局部修改，无需重写整个文件。old_text 必须与文件中的内容完全匹配（包括缩进和换行）。',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '文件路径（相对于项目根目录或绝对路径）' },
        old_text: { type: 'string', description: '要被替换的原始文本（必须精确匹配文件中的内容）' },
        new_text: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'exec_cmd',
    description: '在本机执行 shell 命令，返回 stdout/stderr（仅 agent admin 可用）。超时默认 30 秒。',
    input_schema: {
      type: 'object' as const,
      properties: {
        cmd: { type: 'string', description: '要执行的 shell 命令' },
        timeout_ms: { type: 'number', description: '超时毫秒数，默认 30000' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'reload_app',
    description: '触发应用热重载，使代码变更生效（仅管理员可用）。会以退出码 120 退出，由 launcher 自动重启。',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

function checkProjectPath(inputPath: string): { filePath: string; relative: string } | { error: string } {
  let filePath = inputPath;
  if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(PROJECT_ROOT, filePath);
  }
  filePath = path.normalize(filePath);

  if (filePath !== PROJECT_ROOT && !filePath.startsWith(PROJECT_ROOT + path.sep)) {
    return { error: `路径不在项目目录内: ${filePath}` };
  }

  const relative = filePath === PROJECT_ROOT ? '' : filePath.slice(PROJECT_ROOT.length + 1);
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.endsWith('/')) {
      if (relative.startsWith(pattern) || relative.includes('/' + pattern)) {
        return { error: `禁止写入路径: ${relative}` };
      }
    } else if (pattern.includes('*')) {
      const [dir, ext] = pattern.split('*');
      if (relative.startsWith(dir) && relative.endsWith(ext)) {
        return { error: `禁止写入路径: ${relative}` };
      }
    } else {
      if (relative === pattern || relative.endsWith('/' + pattern)) {
        return { error: `禁止写入路径: ${relative}` };
      }
    }
  }

  return { filePath, relative };
}

function handleListDirectory(input: { path: string }): string {
  const auth = authorizeRead(input.path);
  if ('error' in auth) {
    return JSON.stringify({ error: auth.error.replace(/^read_file 拒绝/, 'list_directory 拒绝') });
  }

  try {
    const stat = fs.statSync(auth.filePath);
    if (!stat.isDirectory()) {
      return JSON.stringify({ error: `不是目录: ${auth.relative}` });
    }
    const entries = fs.readdirSync(auth.filePath, { withFileTypes: true })
      .filter(e => !HIDDEN_DIRECTORY_NAMES.has(e.name))
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      }));
    return JSON.stringify(entries);
  } catch (err: any) {
    return JSON.stringify({ error: `无法读取目录: ${err.message}` });
  }
}

function handleReadFile(input: { path: string; max_lines?: number }): string {
  const auth = authorizeRead(input.path);
  if ('error' in auth) return JSON.stringify({ error: auth.error });

  const maxLines = input.max_lines ?? 500;
  try {
    const content = fs.readFileSync(auth.filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n...(共 ${lines.length} 行，已截断前 ${maxLines} 行)`;
    }
    return content;
  } catch (err: any) {
    return JSON.stringify({ error: `无法读取文件: ${err.message}` });
  }
}

function handleWriteFile(input: { path: string; content: string }): string {
  if (!isSystemAdmin()) return JSON.stringify({ error: '权限不足：需要系统管理员权限' });

  const checked = checkProjectPath(input.path);
  if ('error' in checked) return JSON.stringify({ error: checked.error });
  const { filePath, relative } = checked;

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, input.content, 'utf-8');
    const willReload = markReloadIfSource(filePath);
    return JSON.stringify({ success: true, path: relative, bytes: Buffer.byteLength(input.content, 'utf-8'), reload: willReload });
  } catch (err: any) {
    return JSON.stringify({ error: `写入失败: ${err.message}` });
  }
}

function handleEditFile(input: { path: string; old_text: string; new_text: string }): string {
  if (!isSystemAdmin()) return JSON.stringify({ error: '权限不足：需要系统管理员权限' });

  const checked = checkProjectPath(input.path);
  if ('error' in checked) return JSON.stringify({ error: checked.error });
  const { filePath, relative } = checked;

  try {
    if (!fs.existsSync(filePath)) {
      return JSON.stringify({ error: `文件不存在: ${relative}` });
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const idx = content.indexOf(input.old_text);
    if (idx === -1) {
      return JSON.stringify({ error: '未找到匹配的 old_text，请确认内容完全一致（包括缩进和换行）' });
    }
    const secondIdx = content.indexOf(input.old_text, idx + 1);
    if (secondIdx !== -1) {
      return JSON.stringify({ error: `old_text 在文件中匹配到多处（至少第 ${idx + 1} 和 ${secondIdx + 1} 字符处），请提供更精确的上下文以唯一定位` });
    }
    const newContent = content.slice(0, idx) + input.new_text + content.slice(idx + input.old_text.length);
    fs.writeFileSync(filePath, newContent, 'utf-8');
    const willReload = markReloadIfSource(filePath);
    return JSON.stringify({ success: true, path: relative, bytes: Buffer.byteLength(newContent, 'utf-8'), reload: willReload });
  } catch (err: any) {
    return JSON.stringify({ error: `编辑失败: ${err.message}` });
  }
}

function handleExecCmd(input: { cmd: string; timeout_ms?: number }): string {
  if (!isAgentAdmin(getCurrentAgent()?.id ?? '')) {
    return JSON.stringify({ error: '权限不足：仅 agent admin 可执行命令' });
  }
  const timeout = input.timeout_ms ?? 30000;
  try {
    const output = execSync(input.cmd, { timeout, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.stringify({ stdout: output, exit_code: 0 });
  } catch (err: any) {
    return JSON.stringify({ stdout: err.stdout ?? '', stderr: err.stderr ?? '', exit_code: err.status ?? 1 });
  }
}

function handleReloadApp(): string {
  if (!isSystemAdmin()) return JSON.stringify({ error: '权限不足：需要系统管理员权限' });
  markReloadIfSource('reload.ts'); // always mark as source to trigger reload
  return JSON.stringify({ success: true, message: '将在当前对话轮次结束后重载应用' });
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'list_directory': return handleListDirectory(input);
    case 'read_file': return handleReadFile(input);
    case 'write_file': return handleWriteFile(input);
    case 'edit_file': return handleEditFile(input);
    case 'exec_cmd': return handleExecCmd(input);
    case 'reload_app': return handleReloadApp();
    default: return null;
  }
}
