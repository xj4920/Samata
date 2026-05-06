import type { PluginModule } from '@samata/plugin-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

function resolveFilePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME || '', filePath.slice(1));
  }
  return path.resolve(filePath);
}

interface ExtractedImage {
  filename: string;
  relativePath: string;
}

// ---------------------------------------------------------------------------
// Marker-based conversion (preferred when available)
// ---------------------------------------------------------------------------

let _markerChecked = false;
let _markerAvailable = false;

function checkMarker(): boolean {
  if (_markerChecked) return _markerAvailable;
  _markerChecked = true;
  try {
    execFileSync('marker_single', ['--help'], { stdio: 'pipe', timeout: 10000 });
    _markerAvailable = true;
  } catch {
    try {
      execFileSync('marker', ['--help'], { stdio: 'pipe', timeout: 10000 });
      _markerAvailable = true;
    } catch {
      _markerAvailable = false;
    }
  }
  return _markerAvailable;
}

function getMarkerCmd(): string {
  try {
    execFileSync('marker_single', ['--help'], { stdio: 'pipe', timeout: 5000 });
    return 'marker_single';
  } catch {
    return 'marker';
  }
}

function parseWithMarker(
  filePath: string,
  imageDir: string | null,
): { content: string; images: ExtractedImage[] } {
  const tmpOut = fs.mkdtempSync(path.join(path.dirname(filePath), '.marker_out_'));
  try {
    const cmd = getMarkerCmd();
    const args = [filePath, '--output_dir', tmpOut];

    execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: 300000,
      maxBuffer: 100 * 1024 * 1024,
      stdio: 'pipe',
    });

    // Marker outputs: <output_dir>/<filename>/<filename>.md + images
    const baseName = path.basename(filePath, path.extname(filePath));
    const outDir = path.join(tmpOut, baseName);
    const mdFile = path.join(outDir, `${baseName}.md`);

    if (!fs.existsSync(mdFile)) {
      const candidates = findMarkdownFiles(tmpOut);
      if (candidates.length === 0) {
        throw new Error('Marker 未生成 Markdown 输出');
      }
      return readMarkerOutput(candidates[0], outDir, imageDir);
    }

    return readMarkerOutput(mdFile, outDir, imageDir);
  } finally {
    try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch {}
  }
}

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findMarkdownFiles(full));
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results;
}

function readMarkerOutput(
  mdFile: string,
  outDir: string,
  imageDir: string | null,
): { content: string; images: ExtractedImage[] } {
  let content = fs.readFileSync(mdFile, 'utf-8');
  const images: ExtractedImage[] = [];

  if (!imageDir) return { content, images };

  fs.mkdirSync(imageDir, { recursive: true });

  // Collect image files from marker output
  const imgExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
  if (fs.existsSync(outDir)) {
    for (const file of fs.readdirSync(outDir)) {
      if (imgExtensions.has(path.extname(file).toLowerCase())) {
        const src = path.join(outDir, file);
        const dest = path.join(imageDir, file);
        fs.copyFileSync(src, dest);
        images.push({ filename: file, relativePath: `images/${file}` });
      }
    }
  }

  // Rewrite image paths in markdown to use relative paths
  if (images.length > 0) {
    content = content.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (match, alt, src) => {
        const basename = path.basename(src);
        const found = images.find(i => i.filename === basename);
        if (found) return `![${alt}](${found.relativePath})`;
        return match;
      },
    );
  }

  return { content, images };
}

// ---------------------------------------------------------------------------
// pdf-parse fallback
// ---------------------------------------------------------------------------

async function parseWithPdfParse(filePath: string): Promise<{ content: string; pages: number }> {
  const pdfParse = (await import('pdf-parse')).default;
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return { content: data.text, pages: data.numpages };
}

function validatePdfStructure(filePath: string): string | null {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return '文件为空，不是有效 PDF';
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(1024, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    if (!head.toString('latin1').includes('%PDF-')) {
      return '文件头不是 %PDF-，不是有效 PDF。请确认传入的是原始 PDF 文件路径';
    }

    const tailLength = Math.min(4096, stat.size);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, stat.size - tailLength);
    if (!tail.toString('latin1').includes('%%EOF')) {
      return `文件不是完整 PDF（大小 ${stat.size} bytes，缺少 %%EOF）。请先用 download_file 下载原始 PDF URL，不要用 write_artifact 写入 PDF 文本片段`;
    }

    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleParsePdf(input: {
  file_path: string;
  max_chars?: number;
  image_output_dir?: string;
}): Promise<string> {
  const resolved = resolveFilePath(input.file_path);
  if (!fs.existsSync(resolved)) {
    return JSON.stringify({ error: `文件不存在: ${resolved}` });
  }

  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.pdf') {
    return JSON.stringify({ error: `不支持的格式 "${ext}"，仅支持 .pdf` });
  }

  const structureError = validatePdfStructure(resolved);
  if (structureError) {
    return JSON.stringify({ error: `PDF 解析失败: ${structureError}` });
  }

  const maxChars = input.max_chars ?? 100000;
  const imageDir = input.image_output_dir ? resolveFilePath(input.image_output_dir) : null;

  try {
    let content: string;
    let images: ExtractedImage[] = [];
    let engine: string;
    let pages: number | undefined;

    if (checkMarker()) {
      const result = parseWithMarker(resolved, imageDir);
      content = result.content;
      images = result.images;
      engine = 'marker';
    } else {
      const result = await parseWithPdfParse(resolved);
      content = result.content;
      pages = result.pages;
      engine = 'pdf-parse';
    }

    const truncated = content.length > maxChars;
    if (truncated) content = content.slice(0, maxChars);

    return JSON.stringify({
      file: path.basename(resolved),
      engine,
      pages,
      char_count: content.length,
      truncated,
      content,
      images,
    });
  } catch (err: any) {
    return JSON.stringify({ error: `PDF 解析失败: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PluginModule = {
  name: 'pdf-parser',
  description: '解析 PDF 文件，提取文本内容（Marker 可用时支持学术公式和图片提取）',

  toolDefinitions: [
    {
      name: 'parse_pdf',
      description: '解析 PDF 文件，提取文本内容。Marker 可用时自动保留 LaTeX 公式和提取图片。',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string', description: '文件路径（支持 ~/ 相对路径）' },
          max_chars: { type: 'number', description: '最大返回字符数，默认 100000' },
          image_output_dir: { type: 'string', description: '图片输出目录路径，传入后将提取 PDF 中的图片保存至该目录' },
        },
        required: ['file_path'],
      },
    },
  ],

  async handleTool(name, input) {
    if (name === 'parse_pdf') return handleParsePdf(input);
    return null;
  },
};

export default plugin;
