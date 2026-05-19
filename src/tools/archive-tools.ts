import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'extract_archive',
    description: '解压压缩包文件，支持 .zip、.rar、.7z、.tar.gz、.tgz、.tar.bz2、.tar 格式。解压后返回文件列表和输出目录。',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: '压缩包文件路径（支持 ~/ 相对路径）' },
        output_dir: { type: 'string', description: '解压目标目录（可选，默认自动生成临时目录）' },
      },
      required: ['file_path'],
    },
  },
];

function resolveFilePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME || '', filePath.slice(1));
  }
  return path.resolve(filePath);
}

function detectFormat(filePath: string): 'zip' | 'rar' | 'tar' | '7z' | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.rar')) return 'rar';
  if (lower.endsWith('.7z')) return '7z';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tar')) return 'tar';
  return null;
}

function listFilesRecursive(dir: string): { path: string; size: number }[] {
  const results: { path: string; size: number }[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    } else {
      const stat = fs.statSync(fullPath);
      results.push({ path: path.relative(dir, fullPath), size: stat.size });
    }
  }
  return results;
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function handleExtractArchive(input: { file_path: string; output_dir?: string }): string {
  const resolved = resolveFilePath(input.file_path);

  if (!fs.existsSync(resolved)) {
    return JSON.stringify({ error: `文件不存在: ${resolved}` });
  }

  const format = detectFormat(resolved);
  if (!format) {
    return JSON.stringify({ error: `不支持的格式，支持: .zip, .rar, .7z, .tar.gz, .tgz, .tar.bz2, .tar` });
  }

  const basename = path.basename(resolved).replace(/\.(zip|rar|7z|tar\.gz|tgz|tar\.bz2|tar)$/i, '');
  const outDir = input.output_dir
    ? resolveFilePath(input.output_dir)
    : path.join(os.tmpdir(), 'samata', 'extracted', `${basename}-${Date.now()}`);

  fs.mkdirSync(outDir, { recursive: true });

  try {
    switch (format) {
      case 'zip':
        if (!commandExists('unzip')) {
          return JSON.stringify({ error: '系统未安装 unzip，请执行: sudo apt install unzip' });
        }
        execSync(`unzip -o "${resolved}" -d "${outDir}"`, { stdio: 'pipe' });
        break;
      case 'tar':
        execSync(`tar xf "${resolved}" -C "${outDir}"`, { stdio: 'pipe' });
        break;
      case 'rar':
        if (!commandExists('unrar')) {
          return JSON.stringify({ error: '系统未安装 unrar，请执行: sudo apt install unrar' });
        }
        execSync(`unrar x -o+ "${resolved}" "${outDir}/"`, { stdio: 'pipe' });
        break;
      case '7z':
        if (!commandExists('7z')) {
          return JSON.stringify({ error: '系统未安装 7z，请执行: sudo apt install p7zip-full' });
        }
        execSync(`7z x "${resolved}" -o"${outDir}" -y`, { stdio: 'pipe' });
        break;
    }
  } catch (err: any) {
    return JSON.stringify({ error: `解压失败: ${err.message}` });
  }

  const files = listFilesRecursive(outDir);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  return JSON.stringify({
    output_dir: outDir,
    total_files: files.length,
    total_size: totalSize,
    files: files.slice(0, 200),
    truncated: files.length > 200,
  });
}

export async function handleTool(name: string, input: any): Promise<string | null> {
  if (name === 'extract_archive') return handleExtractArchive(input);
  return null;
}
