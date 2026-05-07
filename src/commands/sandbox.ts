/**
 * Sandbox command — isolated execution environment per (agent, user).
 *
 * Each sandbox lives at /tmp/samata/sandboxes/{agentName}/{userId}/.
 * Lazy-created on first write or exec. Cleaned up on session expiry.
 *
 * Execution uses bwrap (bubblewrap) for true filesystem isolation when
 * available: the child process can only see system dirs and the sandbox
 * directory. Project files (yanyu.db, .env, source code, etc.) are
 * completely invisible inside the sandbox.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

const SANDBOX_BASE = path.join(os.tmpdir(), 'samata', 'sandboxes');
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const GF_PIP_INDEX_URL = 'http://pypi.gf.com.cn/simple/';
const GF_PIP_TRUSTED_HOST = 'pypi.gf.com.cn';
const SANDBOX_PYTHON_ROOT = '/usr/local/python-3.10.4';
const SANDBOX_PATH = `${SANDBOX_PYTHON_ROOT}/bin:/usr/local/bin:/usr/bin:/bin`;
const SANDBOX_LD_LIBRARY_PATH = `${SANDBOX_PYTHON_ROOT}/lib:/usr/local/lib`;

const SANDBOX_PYTHON_USER_SITE = (() => {
  try {
    const py = path.join(SANDBOX_PYTHON_ROOT, 'bin', 'python3.10');
    const r = spawnSync(py, ['-c', 'import site; print(site.getusersitepackages())'], {
      encoding: 'utf-8', timeout: 5000,
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

function ensureSandboxDir(agentName: string, userId: string): string {
  const root = getSandboxRoot(agentName, userId);
  fs.mkdirSync(root, { recursive: true });

  // Ensure python3 symlink exists in sandbox bin/ so "python3 script.py" works
  const binDir = path.join(root, '.bin');
  const python3Link = path.join(binDir, 'python3');
  if (!fs.existsSync(python3Link)) {
    fs.mkdirSync(binDir, { recursive: true });
    const target = path.join(SANDBOX_PYTHON_ROOT, 'bin', 'python3.10');
    try { fs.symlinkSync(target, python3Link); } catch {}
  }

  return root;
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

export function sandboxWriteFile(
  agentName: string,
  userId: string,
  filePath: string,
  content: string,
): { success: boolean; path: string; bytes: number; error?: string } {
  const root = ensureSandboxDir(agentName, userId);
  const checked = checkPath(root, filePath);
  if (typeof checked === 'object' && 'error' in checked) {
    return { success: false, path: filePath, bytes: 0, error: checked.error };
  }
  try {
    const dir = path.dirname(checked);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(checked, content, 'utf-8');
    return { success: true, path: filePath, bytes: Buffer.byteLength(content, 'utf-8') };
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
  try {
    const result = spawnSync('bwrap', ['--version'], { stdio: 'pipe', timeout: 3000 });
    _bwrapAvailable = result.status === 0;
  } catch {
    _bwrapAvailable = false;
  }
  return _bwrapAvailable;
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

function buildBwrapArgs(sandboxRoot: string, cmd: string, args: string[]): string[] {
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

  // Sandbox directory: read-write. Only this path is visible; everything
  // else under /tmp (and the rest of the filesystem) is invisible.
  bwrapArgs.push('--bind', sandboxRoot, sandboxRoot);

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
    language: 'js' | 'shell';
    code: string;
    timeout_ms?: number;
  },
): { stdout: string; stderr: string; exit_code: number; truncated: boolean } {
  const root = ensureSandboxDir(agentName, userId);
  const timeout = Math.min(options.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  let cmd: string;
  let args: string[];

  if (options.language === 'js') {
    const jsFile = path.join(root, `_exec_${Date.now()}.js`);
    fs.writeFileSync(jsFile, options.code, 'utf-8');
    cmd = process.execPath; // node
    args = [jsFile];
  } else {
    const pipError = validatePipInstallCommand(options.code);
    if (pipError) {
      return { stdout: '', stderr: pipError, exit_code: 2, truncated: false };
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
      ? ['bwrap', buildBwrapArgs(root, cmd, args)]
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
    };
  } catch (err: any) {
    return {
      stdout: '',
      stderr: err.message,
      exit_code: err.status ?? 1,
      truncated: false,
    };
  }
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
