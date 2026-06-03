/**
 * Sandbox command — isolated execution environment per (agent, user).
 *
 * Each sandbox lives at /tmp/samata/sandboxes/{agentName}/{userId}/.
 * Lazy-created on first write or exec. Cleaned up on session expiry.
 *
 * Execution uses bwrap (bubblewrap) for true filesystem isolation when
 * available: the child process can only see system dirs and the sandbox
 * directory. Project files (samata.db, .env, source code, etc.) are
 * completely invisible inside the sandbox.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, spawnSync } from 'child_process';

const SANDBOX_BASE = path.join(os.tmpdir(), 'samata', 'sandboxes');
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const GF_PIP_INDEX_URL = 'http://pypi.gf.com.cn/simple/';
const GF_PIP_TRUSTED_HOST = 'pypi.gf.com.cn';
const DEFAULT_SANDBOX_PYTHON_ROOT = '/usr/local/python-3.10.4';
const SANDBOX_PYTHON_ROOT = process.env.SANDBOX_PYTHON_ROOT || DEFAULT_SANDBOX_PYTHON_ROOT;

function isExecutable(filePath: string | undefined | null): filePath is string {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(executable: string): string | null {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, executable);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function uniquePathEntries(entries: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    kept.push(entry);
  }
  return kept.join(':');
}

function resolveSandboxPythonBin(): string {
  const candidates = [
    process.env.SANDBOX_PYTHON_BIN,
    path.join(SANDBOX_PYTHON_ROOT, 'bin', 'python3.10'),
    path.join(SANDBOX_PYTHON_ROOT, 'bin', 'python3'),
    path.join(SANDBOX_PYTHON_ROOT, 'bin', 'python'),
    findOnPath('python3'),
    findOnPath('python'),
    '/usr/bin/python3',
  ];
  return candidates.find(isExecutable) || 'python3';
}

const SANDBOX_PYTHON_BIN = resolveSandboxPythonBin();
const SANDBOX_PYTHON_BIN_DIR = path.isAbsolute(SANDBOX_PYTHON_BIN)
  ? path.dirname(SANDBOX_PYTHON_BIN)
  : null;
const SANDBOX_PYTHON_ROOT_BIN = path.join(SANDBOX_PYTHON_ROOT, 'bin');
const SANDBOX_PYTHON_ROOT_LIB = path.join(SANDBOX_PYTHON_ROOT, 'lib');
const SANDBOX_PATH = uniquePathEntries([
  SANDBOX_PYTHON_BIN_DIR,
  fs.existsSync(SANDBOX_PYTHON_ROOT_BIN) ? SANDBOX_PYTHON_ROOT_BIN : null,
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]);
const SANDBOX_LD_LIBRARY_PATH = uniquePathEntries([
  fs.existsSync(SANDBOX_PYTHON_ROOT_LIB) ? SANDBOX_PYTHON_ROOT_LIB : null,
  '/usr/local/lib',
  '/usr/lib',
]);

/** Written to $HOME/.config/matplotlib/matplotlibrc (HOME = sandbox root under bwrap). */
const SANDBOX_MATPLOTLIBRC = [
  'font.sans-serif: Noto Sans CJK SC, Noto Sans CJK TC, Noto Sans CJK JP, WenQuanYi Zen Hei, SimHei, DejaVu Sans',
  'axes.unicode_minus: False',
  '',
].join('\n');

const SANDBOX_PYTHON_USER_SITE = (() => {
  try {
    const r = spawnSync(SANDBOX_PYTHON_BIN, ['-c', 'import site; print(site.getusersitepackages())'], {
      encoding: 'utf-8', timeout: 5000, env: { ...process.env, PATH: SANDBOX_PATH },
    });
    return r.stdout?.trim() || '';
  } catch { return ''; }
})();

function debugSandboxLog(input: {
  runId: string;
  hypothesisId: string;
  location: string;
  message: string;
  data: Record<string, unknown>;
}): void {
  const debugFetch = (globalThis as any).fetch;
  if (typeof debugFetch !== 'function') return;
  debugFetch('http://localhost:7251/ingest/b69fbe4a-9d71-44d1-b487-f32b66832e46', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5ba2d0' }, body: JSON.stringify({ sessionId: '5ba2d0', ...input, timestamp: Date.now() }) }).catch(() => {});
}

export function getSandboxRoot(agentName: string, userId: string): string {
  return path.join(SANDBOX_BASE, agentName, userId);
}

function ensureExecutableSymlink(linkPath: string, target: string | null): void {
  if (!target || !path.isAbsolute(target) || !isExecutable(target)) return;
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() && fs.readlinkSync(linkPath) === target) return;
    fs.rmSync(linkPath, { force: true });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return;
  }
  try { fs.symlinkSync(target, linkPath); } catch {}
}

function ensureSandboxDir(agentName: string, userId: string): string {
  const root = getSandboxRoot(agentName, userId);
  fs.mkdirSync(root, { recursive: true });

  // Ensure common runtime commands exist in sandbox bin/ for shell snippets.
  const binDir = path.join(root, '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  ensureExecutableSymlink(path.join(binDir, 'python3'), SANDBOX_PYTHON_BIN);
  ensureExecutableSymlink(path.join(binDir, 'python'), SANDBOX_PYTHON_BIN);
  ensureExecutableSymlink(path.join(binDir, 'node'), process.execPath);
  ensureExecutableSymlink(path.join(binDir, 'npm'), findOnPath('npm'));
  ensureExecutableSymlink(path.join(binDir, 'npx'), findOnPath('npx'));

  ensureSandboxMatplotlibRc(root);

  return root;
}

function ensureSandboxMatplotlibRc(sandboxRoot: string): void {
  const mplDir = path.join(sandboxRoot, '.config', 'matplotlib');
  const rcPath = path.join(mplDir, 'matplotlibrc');
  if (fs.existsSync(rcPath)) return;
  fs.mkdirSync(mplDir, { recursive: true });
  fs.writeFileSync(rcPath, SANDBOX_MATPLOTLIBRC, 'utf-8');
}

function checkPath(root: string, inputPath: string): string | { error: string } {
  if (!inputPath || inputPath.includes('..')) {
    return { error: '路径不可为空且不得包含 ".."' };
  }
  const resolved = path.resolve(root, inputPath);
  const allowed = resolved.startsWith(root + path.sep) || resolved === root;
  // #region agent log
  debugSandboxLog({
    runId: 'pre-fix',
    hypothesisId: 'A,C',
    location: 'src/commands/sandbox.ts:checkPath',
    message: 'sandbox path resolution',
    data: {
      inputPath,
      isAbsolute: path.isAbsolute(inputPath),
      allowed,
      resolvedInsideRoot: allowed,
    },
  });
  // #endregion
  if (!allowed) {
    return { error: `路径不允许穿越沙箱根目录: ${inputPath}` };
  }
  return resolved;
}

function checkPythonSyntax(filePath: string): string | null {
  try {
    const r = spawnSync(SANDBOX_PYTHON_BIN, ['-m', 'py_compile', filePath], {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: SANDBOX_PATH },
    });
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || '').trim();
      return msg || 'Python syntax error (unknown)';
    }
    return null;
  } catch {
    return null; // validation failed to run — don't block the write
  }
}

export function sandboxWriteFile(
  agentName: string,
  userId: string,
  filePath: string,
  content: string,
): { success: boolean; path: string; bytes: number; error?: string; syntax_error?: string } {
  const root = ensureSandboxDir(agentName, userId);
  const checked = checkPath(root, filePath);
  if (typeof checked === 'object' && 'error' in checked) {
    return { success: false, path: filePath, bytes: 0, error: checked.error };
  }
  try {
    const dir = path.dirname(checked);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(checked, content, 'utf-8');
    const bytes = Buffer.byteLength(content, 'utf-8');

    if (filePath.endsWith('.py')) {
      const syntaxErr = checkPythonSyntax(checked);
      if (syntaxErr) {
        return {
          success: true, path: filePath, bytes,
          syntax_error: `${syntaxErr}\n提示：避免使用三引号字符串(\"\"\"....\"\"\")，改用单引号包裹 SQL，如 cur.execute('SELECT "COL" FROM "TABLE"', params)`,
        };
      }
    }

    return { success: true, path: filePath, bytes };
  } catch (err: any) {
    return { success: false, path: filePath, bytes: 0, error: err.message };
  }
}

export function sandboxReadFile(
  agentName: string,
  userId: string,
  filePath: string,
  maxLines = 500,
): { content: string; totalLines?: number; truncated?: boolean } | { error: string } {
  const root = getSandboxRoot(agentName, userId);
  // #region agent log
  debugSandboxLog({
    runId: 'pre-fix',
    hypothesisId: 'A,C,D',
    location: 'src/commands/sandbox.ts:sandboxReadFile',
    message: 'sandbox read request',
    data: {
      agentName,
      filePath,
      isAbsolute: path.isAbsolute(filePath),
      rootExists: fs.existsSync(root),
      maxLines,
    },
  });
  // #endregion
  if (!fs.existsSync(root)) return { error: '沙箱目录不存在，请先写入文件' };
  const checked = checkPath(root, filePath);
  if (typeof checked === 'object' && 'error' in checked) return checked;
  try {
    if (!fs.existsSync(checked)) return { error: `文件不存在: ${filePath}` };
    const raw = fs.readFileSync(checked, 'utf-8');
    const lines = raw.split('\n');
    if (lines.length > maxLines) {
      return {
        content: lines.slice(0, maxLines).join('\n') + `\n...(共 ${lines.length} 行，已截断前 ${maxLines} 行)`,
        totalLines: lines.length,
        truncated: true,
      };
    }
    return { content: raw };
  } catch (err: any) {
    return { error: err.message };
  }
}

export function sandboxList(
  agentName: string,
  userId: string,
  subPath?: string,
): { files: Array<{ name: string; type: 'file' | 'directory'; size: number }> } | { error: string } {
  const root = getSandboxRoot(agentName, userId);
  if (!fs.existsSync(root)) return { files: [] };
  const target = subPath ? checkPath(root, subPath) : root;
  if (typeof target === 'object' && 'error' in target) return target;
  try {
    if (!fs.existsSync(target)) return { files: [] };
    const entries = fs.readdirSync(target, { withFileTypes: true });
    // #region agent log
    debugSandboxLog({
      runId: 'pre-fix',
      hypothesisId: 'D',
      location: 'src/commands/sandbox.ts:sandboxList',
      message: 'sandbox list result',
      data: {
        subPath: subPath ?? '',
        entryCount: entries.length,
        relevantEntries: entries
          .map(e => e.name)
          .filter(name => /guangfa|report|报告/i.test(name))
          .slice(0, 20),
      },
    });
    // #endregion
    return {
      files: entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        size: e.isFile() ? fs.statSync(path.join(target, e.name)).size : 0,
      })),
    };
  } catch (err: any) {
    return { error: err.message };
  }
}

// --- bwrap-based filesystem isolation ---

let _bwrapChecked = false;
let _bwrapAvailable = false;

function isBwrapAvailable(): boolean {
  if (_bwrapChecked) return _bwrapAvailable;
  _bwrapChecked = true;
  if (/^(1|true|yes)$/i.test(process.env.SAMATA_DISABLE_BWRAP || '')) {
    _bwrapAvailable = false;
    return _bwrapAvailable;
  }
  try {
    // Docker often allows `bwrap --version` while blocking namespace creation.
    // Treat bubblewrap as available only if a minimal sandbox can actually run.
    const result = spawnSync('bwrap', [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind', '/bin', '/bin',
      '--proc', '/proc',
      '--dev', '/dev',
      '--unshare-pid',
      '--unshare-ipc',
      '--die-with-parent',
      '--',
      '/bin/sh',
      '-c',
      'true',
    ], { stdio: 'pipe', timeout: 3000 });
    _bwrapAvailable = result.status === 0;
  } catch {
    _bwrapAvailable = false;
  }
  return _bwrapAvailable;
}

function validateNoAbsolutePaths(code: string): string | null {
  if (/\bcd\s+\//.test(code)) {
    return 'sandbox_exec 拒绝执行：检测到 cd 到绝对路径。cwd 已是沙箱根目录，请直接使用相对路径（如 python3 script.py）';
  }
  if (/\/tmp\/samata\/sandboxes\//.test(code)) {
    return 'sandbox_exec 拒绝执行：禁止引用沙箱内部绝对路径。直接使用相对路径即可（如 python3 script.py）';
  }
  if (/\/tmp\/[^\s]+\.py\b/.test(code)) {
    return 'sandbox_exec 拒绝执行：检测到 /tmp/*.py 绝对路径引用。sandbox_write_file 写入的文件在 cwd 中，直接用相对路径（如 python3 script.py）';
  }
  return null;
}

function validatePipInstallCommand(code: string): string | null {
  const usesPipInstall = /\b(?:pip3?|python(?:3(?:\.\d+)?)?\s+-m\s+pip)\s+install\b/.test(code);
  if (!usesPipInstall) return null;

  const hasIndex =
    code.includes(`--index ${GF_PIP_INDEX_URL}`) ||
    code.includes(`--index-url ${GF_PIP_INDEX_URL}`) ||
    code.includes(`-i ${GF_PIP_INDEX_URL}`);
  const hasTrustedHost = code.includes(`--trusted-host ${GF_PIP_TRUSTED_HOST}`);
  if (hasIndex && hasTrustedHost) return null;

  return [
    'sandbox_exec 拒绝执行：pip install 必须使用公司内网 PyPI 源。',
    `请改用：python3 -m pip install <package> --index ${GF_PIP_INDEX_URL} --trusted-host ${GF_PIP_TRUSTED_HOST}`,
  ].join('\n');
}

/**
 * Detect the node version manager root so we can mount it read-only inside
 * the sandbox. Returns null if node is under /usr (already covered by the
 * standard /usr mount).
 */
function findNodeToolRoot(): string | null {
  const execPath = process.execPath;
  if (execPath.startsWith('/usr/')) return null;

  const knownManagers = ['.nvm', '.fnm', '.asdf', '.volta'];
  const parts = execPath.split('/').filter(Boolean);
  for (const mgr of knownManagers) {
    const idx = parts.indexOf(mgr);
    if (idx >= 2) {
      return '/' + parts.slice(0, idx + 1).join('/');
    }
  }

  // Unknown layout — mount the directory containing the node binary
  return path.dirname(execPath);
}

const ALLOWLIST_DIR = path.join(process.cwd(), 'config', 'agents');
const PROJECT_ROOT = process.cwd();

function loadSandboxAllowlist(agentName: string): string[] {
  const file = path.join(ALLOWLIST_DIR, `${agentName}.files.json`);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
      return parsed.map(p => p.replace(/^\/+/, ''));
    }
  } catch {}
  return [];
}

function buildBwrapArgs(sandboxRoot: string, cmd: string, args: string[], agentName?: string): string[] {
  const bwrapArgs: string[] = [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/etc', '/etc',
    // /etc/resolv.conf symlinks to ../run/resolvconf/resolv.conf
    '--ro-bind-try', '/run/resolvconf', '/run/resolvconf',
    '--proc', '/proc',
    '--dev', '/dev',
  ];

  // Mount node installation dir if not under /usr
  const nodeRoot = findNodeToolRoot();
  if (nodeRoot && fs.existsSync(nodeRoot)) {
    bwrapArgs.push('--ro-bind', nodeRoot, nodeRoot);
  }

  // Mount Python user site-packages (e.g. ~/.local/lib/python3.10/site-packages)
  if (SANDBOX_PYTHON_USER_SITE && fs.existsSync(SANDBOX_PYTHON_USER_SITE)) {
    bwrapArgs.push('--ro-bind', SANDBOX_PYTHON_USER_SITE, SANDBOX_PYTHON_USER_SITE);
  }

  // Sandbox directory: read-write. Only this path is visible; everything
  // else under /tmp (and the rest of the filesystem) is invisible.
  bwrapArgs.push('--bind', sandboxRoot, sandboxRoot);

  // Mount agent allowlisted project files read-only into .data/
  if (agentName) {
    const allowlist = loadSandboxAllowlist(agentName);
    for (const relPath of allowlist) {
      const src = path.join(PROJECT_ROOT, relPath);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(sandboxRoot, '.data', relPath);
      const destDir = path.dirname(dest);
      fs.mkdirSync(destDir, { recursive: true });
      bwrapArgs.push('--ro-bind', src, dest);
    }
  }

  // Change to sandbox directory
  bwrapArgs.push('--chdir', sandboxRoot);

  // Override critical env vars; mount namespace handles filesystem isolation
  bwrapArgs.push('--setenv', 'HOME', sandboxRoot);
  bwrapArgs.push('--setenv', 'TMPDIR', sandboxRoot);
  bwrapArgs.push('--setenv', 'PWD', sandboxRoot);
  bwrapArgs.push('--setenv', 'PATH', `${sandboxRoot}/.bin:${SANDBOX_PATH}`);
  bwrapArgs.push('--setenv', 'LD_LIBRARY_PATH', SANDBOX_LD_LIBRARY_PATH);
  if (SANDBOX_PYTHON_USER_SITE) {
    bwrapArgs.push('--setenv', 'PYTHONPATH', SANDBOX_PYTHON_USER_SITE);
  }
  bwrapArgs.push('--unsetenv', 'NVM_DIR');
  bwrapArgs.push('--unsetenv', 'NVM_BIN');
  bwrapArgs.push('--unsetenv', 'NVM_INC');
  bwrapArgs.push('--unsetenv', 'NODE_PATH');

  // Isolate process namespace
  bwrapArgs.push('--unshare-pid', '--unshare-ipc');

  // Kill sandbox when parent exits
  bwrapArgs.push('--die-with-parent');

  // Separator + command
  bwrapArgs.push('--', cmd, ...args);

  return bwrapArgs;
}

export function sandboxExec(
  agentName: string,
  userId: string,
  options: {
    language: 'js' | 'shell' | 'python';
    code: string;
    timeout_ms?: number;
  },
): SandboxExecResult {
  const root = ensureSandboxDir(agentName, userId);
  const timeout = Math.min(options.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const filesBefore = snapshotFiles(root);

  let cmd: string;
  let args: string[];

  if (options.language === 'js') {
    const jsFile = path.join(root, `_exec_${Date.now()}.js`);
    fs.writeFileSync(jsFile, options.code, 'utf-8');
    cmd = process.execPath; // node
    args = [jsFile];
  } else if (options.language === 'python') {
    const pyFile = path.join(root, `_exec_${Date.now()}.py`);
    fs.writeFileSync(pyFile, options.code, 'utf-8');
    const syntaxErr = checkPythonSyntax(pyFile);
    if (syntaxErr) {
      return {
        stdout: '', exit_code: 2, truncated: false, generated_files: [],
        stderr: `${syntaxErr}\n提示：避免使用三引号字符串(\"\"\"....\"\"\")，改用单引号包裹 SQL`,
      };
    }
    cmd = SANDBOX_PYTHON_BIN;
    args = ['-B', pyFile];
  } else {
    const pipError = validatePipInstallCommand(options.code);
    if (pipError) {
      return { stdout: '', stderr: pipError, exit_code: 2, truncated: false, generated_files: [] };
    }
    const absPathError = validateNoAbsolutePaths(options.code);
    if (absPathError) {
      return { stdout: '', stderr: absPathError, exit_code: 2, truncated: false, generated_files: [] };
    }
    cmd = '/bin/sh';
    args = ['-c', options.code];
  }

  const useBwrap = isBwrapAvailable();
  // #region agent log
  debugSandboxLog({
    runId: 'pre-fix',
    hypothesisId: 'A,B',
    location: 'src/commands/sandbox.ts:sandboxExec:beforeSpawn',
    message: 'sandbox exec request',
    data: {
      agentName,
      language: options.language,
      useBwrap,
      timeout,
      codeMentionsAbsoluteTmp: /\/tmp\//.test(options.code),
      codeMentionsGuangfaReport: /guangfa_report/i.test(options.code),
      codeMentionsReportFile: /report/i.test(options.code),
    },
  });
  // #endregion

  try {
    const spawnArgs: [string, string[]] = useBwrap
      ? ['bwrap', buildBwrapArgs(root, cmd, args, agentName)]
      : [cmd, args];

    const spawnOpts: Parameters<typeof spawnSync>[2] = useBwrap
      ? { timeout, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf-8', env: {} }
      : {
          timeout,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf-8',
          cwd: root,
          env: {
            HOME: root,
            PWD: root,
            PATH: `${root}/.bin:${SANDBOX_PATH}`,
            LD_LIBRARY_PATH: SANDBOX_LD_LIBRARY_PATH,
            PYTHONPATH: SANDBOX_PYTHON_USER_SITE || undefined,
            TMPDIR: root,
          },
        };

    const result = spawnSync(...spawnArgs, spawnOpts);

    const stdout = String(result.stdout ?? '').slice(0, MAX_OUTPUT_BYTES);
    const stderr = String(result.stderr ?? '').slice(0, MAX_OUTPUT_BYTES);
    const totalLen = (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0);
    const rootEntries = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [];
    // #region agent log
    debugSandboxLog({
      runId: 'pre-fix',
      hypothesisId: 'B,D',
      location: 'src/commands/sandbox.ts:sandboxExec:afterSpawn',
      message: 'sandbox exec result',
      data: {
        exitCode: result.status ?? (result.signal ? -1 : 0),
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        stdoutMentionsGuangfaReport: /guangfa_report/i.test(stdout),
        stderrMentionsGuangfaReport: /guangfa_report/i.test(stderr),
        stdoutMentionsAbsoluteTmp: /\/tmp\//.test(stdout),
        stderrMentionsAbsoluteTmp: /\/tmp\//.test(stderr),
        relevantRootEntries: rootEntries
          .map(e => e.name)
          .filter(name => /guangfa|report|报告/i.test(name))
          .slice(0, 20),
      },
    });
    // #endregion

    return {
      stdout,
      stderr,
      exit_code: result.status ?? (result.signal ? -1 : 0),
      truncated: totalLen > MAX_OUTPUT_BYTES,
      generated_files: diffFiles(filesBefore, root),
    };
  } catch (err: any) {
    return {
      stdout: '',
      stderr: err.message,
      exit_code: err.status ?? 1,
      truncated: false,
      generated_files: [],
    };
  }
}

export type SandboxExecResult = { stdout: string; stderr: string; exit_code: number; truncated: boolean; generated_files: string[] };

function snapshotFiles(root: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  if (!fs.existsSync(root)) return snapshot;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '__pycache__' || entry.name === '.data') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/^_exec_\d+\.(js|py)$/.test(entry.name)) continue;
      try { snapshot.set(full, fs.statSync(full).mtimeMs); } catch {}
    }
  };
  walk(root);
  return snapshot;
}

function toSandboxRelativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function diffFiles(before: Map<string, number>, root: string): string[] {
  const after = snapshotFiles(root);
  const generated: string[] = [];
  for (const [filePath, mtime] of after) {
    const prev = before.get(filePath);
    if (prev === undefined || mtime > prev) {
      generated.push(toSandboxRelativePath(root, filePath));
    }
  }
  return generated;
}

export async function sandboxExecAsync(
  agentName: string,
  userId: string,
  options: {
    language: 'js' | 'shell' | 'python';
    code: string;
    timeout_ms?: number;
  },
  onProgress?: (event: { type: 'tool_progress'; message: string }) => void,
): Promise<SandboxExecResult> {
  const root = ensureSandboxDir(agentName, userId);
  const timeout = Math.min(options.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const filesBefore = snapshotFiles(root);

  let cmd: string;
  let args: string[];

  if (options.language === 'js') {
    const jsFile = path.join(root, `_exec_${Date.now()}.js`);
    fs.writeFileSync(jsFile, options.code, 'utf-8');
    cmd = process.execPath;
    args = [jsFile];
  } else if (options.language === 'python') {
    const pyFile = path.join(root, `_exec_${Date.now()}.py`);
    fs.writeFileSync(pyFile, options.code, 'utf-8');
    const syntaxErr = checkPythonSyntax(pyFile);
    if (syntaxErr) {
      return {
        stdout: '', exit_code: 2, truncated: false, generated_files: [],
        stderr: `${syntaxErr}\n提示：避免使用三引号字符串(\"\"\"....\"\"\")，改用单引号包裹 SQL`,
      };
    }
    cmd = SANDBOX_PYTHON_BIN;
    args = ['-B', pyFile];
  } else {
    const pipError = validatePipInstallCommand(options.code);
    if (pipError) {
      return { stdout: '', stderr: pipError, exit_code: 2, truncated: false, generated_files: [] };
    }
    const absPathError = validateNoAbsolutePaths(options.code);
    if (absPathError) {
      return { stdout: '', stderr: absPathError, exit_code: 2, truncated: false, generated_files: [] };
    }
    cmd = '/bin/sh';
    args = ['-c', options.code];
  }

  const useBwrap = isBwrapAvailable();
  const spawnCmd = useBwrap ? 'bwrap' : cmd;
  const spawnArgs = useBwrap ? buildBwrapArgs(root, cmd, args, agentName) : args;
  const spawnEnv = useBwrap
    ? {}
    : {
        HOME: root,
        PWD: root,
        PATH: `${root}/.bin:${SANDBOX_PATH}`,
        LD_LIBRARY_PATH: SANDBOX_LD_LIBRARY_PATH,
        PYTHONPATH: SANDBOX_PYTHON_USER_SITE || undefined,
        TMPDIR: root,
      };
  const spawnOpts = useBwrap
    ? { env: spawnEnv as NodeJS.ProcessEnv }
    : { cwd: root, env: spawnEnv as NodeJS.ProcessEnv };

  return new Promise<SandboxExecResult>((resolve) => {
    const child = spawn(spawnCmd, spawnArgs, spawnOpts);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let stdoutLines = 0;
    const startTime = Date.now();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLen < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0A) stdoutLines++;
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLen < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    const HEARTBEAT_INTERVAL = 3000;
    const heartbeat = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      onProgress?.({ type: 'tool_progress', message: `sandbox_exec 执行中 (${elapsed}s, stdout ${stdoutLines} 行)` });
    }, HEARTBEAT_INTERVAL);

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeout);

    child.on('close', (code, signal) => {
      clearInterval(heartbeat);
      clearTimeout(killTimer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').slice(0, MAX_OUTPUT_BYTES);
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').slice(0, MAX_OUTPUT_BYTES);
      const truncated = stdoutLen + stderrLen > MAX_OUTPUT_BYTES;

      resolve({
        stdout,
        stderr,
        exit_code: code ?? (signal ? -1 : 0),
        truncated,
        generated_files: diffFiles(filesBefore, root),
      });
    });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      clearTimeout(killTimer);
      resolve({ stdout: '', stderr: err.message, exit_code: 1, truncated: false, generated_files: [] });
    });
  });
}

export function cleanupSandbox(agentName: string, userId: string): void {
  const root = getSandboxRoot(agentName, userId);
  try {
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } catch {
    // best-effort, ignore errors
  }
}
