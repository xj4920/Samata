import type { PluginModule } from '@samata/plugin-sdk';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveFilePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME || '', filePath.slice(1));
  }
  return path.resolve(filePath);
}

interface ParseResult {
  content: string;
  images: { filename: string; relativePath: string }[];
}

interface ParseWordInput {
  file_path: string;
  format?: string;
  max_chars?: number;
  image_output_dir?: string;
}

// ---------------------------------------------------------------------------
// Pandoc-based conversion (preferred when available)
// ---------------------------------------------------------------------------

let _pandocChecked = false;
let _pandocPath: string | null = null;

function findPandoc(): string | null {
  if (_pandocChecked) return _pandocPath;
  _pandocChecked = true;
  try {
    execFileSync('pandoc', ['--version'], { stdio: 'pipe', timeout: 5000 });
    _pandocPath = 'pandoc';
  } catch {
    _pandocPath = null;
  }
  return _pandocPath;
}

function parseWithPandoc(filePath: string, imageDir: string | null): ParseResult {
  const args = [
    '-f', 'docx',
    '-t', 'markdown+tex_math_dollars-raw_html',
    '--wrap=none',
  ];

  if (imageDir) {
    fs.mkdirSync(imageDir, { recursive: true });
    args.push('--extract-media', imageDir);
  }

  args.push(filePath);

  let content = execFileSync('pandoc', args, {
    encoding: 'utf-8',
    timeout: 60000,
    maxBuffer: 50 * 1024 * 1024,
  });

  const images: ParseResult['images'] = [];
  if (imageDir) {
    // Pandoc puts images in <imageDir>/media/imageN.ext
    // Rewrite absolute paths in markdown to relative paths
    const mediaDir = path.join(imageDir, 'media');
    if (fs.existsSync(mediaDir)) {
      for (const file of fs.readdirSync(mediaDir)) {
        const src = path.join(mediaDir, file);
        const dest = path.join(imageDir, file);
        fs.renameSync(src, dest);
        images.push({ filename: file, relativePath: `images/${file}` });
      }
      try { fs.rmdirSync(mediaDir); } catch {}
    }

    // Rewrite image paths from absolute to relative
    content = content.replace(
      /!\[([^\]]*)\]\([^)]*[/\\]([^/\\)]+)\)/g,
      (_, alt, filename) => `![${alt}](images/${filename})`,
    );
  }

  return { content, images };
}

// ---------------------------------------------------------------------------
// Mammoth-based conversion (fallback)
// ---------------------------------------------------------------------------

/** mammoth tables lack <thead>/<th> and wrap cell text in <p>; fix both for turndown-plugin-gfm */
function fixTablesForTurndown(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/gi, (_match, inner: string) => {
    const rows = inner.match(/<tr>[\s\S]*?<\/tr>/gi);
    if (!rows || rows.length < 2) return _match;
    const stripCellParagraphs = (row: string) =>
      row.replace(/(<t[dh][^>]*>)\s*<p>([\s\S]*?)<\/p>\s*(<\/t[dh]>)/gi, '$1$2$3');
    const headerRow = stripCellParagraphs(
      rows[0].replace(/<td(\s|>)/gi, '<th$1').replace(/<\/td>/gi, '</th>'),
    );
    const bodyRows = rows.slice(1).map(stripCellParagraphs).join('');
    return `<table><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
  });
}

function htmlToMarkdown(html: string, imageDir: string | null): { markdown: string; images: ParseResult['images'] } {
  const processed = fixTablesForTurndown(html);
  const td = new TurndownService({ headingStyle: 'atx' });
  td.use(gfm);

  const images: ParseResult['images'] = [];

  if (imageDir) {
    let imgIndex = 0;
    td.addRule('extractImages', {
      filter: (node: HTMLElement) => node.nodeName === 'IMG' && !!node.getAttribute('src'),
      replacement: (_content: string, node: any) => {
        const src: string = node.getAttribute('src') || '';
        if (!src.startsWith('data:')) return `![](${src})`;

        const match = src.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
        if (!match) return '[图片]';

        const ext = match[1].split('/')[1]?.replace('+xml', '') || 'png';
        const buffer = Buffer.from(match[2], 'base64');
        const filename = `img_${String(++imgIndex).padStart(3, '0')}.${ext}`;
        const imgPath = path.join(imageDir, filename);
        fs.writeFileSync(imgPath, buffer);
        images.push({ filename, relativePath: `images/${filename}` });
        return `![](images/${filename})`;
      },
    });
  } else {
    td.addRule('base64Images', {
      filter: (node: HTMLElement) =>
        node.nodeName === 'IMG' && (node.getAttribute('src')?.startsWith('data:') ?? false),
      replacement: () => '[图片]',
    });
  }

  return { markdown: td.turndown(processed), images };
}

async function parseWithMammoth(filePath: string, format: string, imageDir: string | null): Promise<ParseResult> {
  if (format === 'text') {
    const result = await mammoth.extractRawText({ path: filePath });
    return { content: result.value, images: [] };
  }

  const result = await mammoth.convertToHtml({ path: filePath });
  if (imageDir) fs.mkdirSync(imageDir, { recursive: true });
  const { markdown, images } = htmlToMarkdown(result.value, imageDir);
  return { content: markdown, images };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleParseWord(input: ParseWordInput): Promise<string> {
  const resolved = resolveFilePath(input.file_path);
  if (!fs.existsSync(resolved)) {
    return JSON.stringify({ error: `文件不存在: ${resolved}` });
  }

  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.docx') {
    return JSON.stringify({ error: `不支持的格式 "${ext}"，仅支持 .docx` });
  }

  const format = input.format === 'markdown' ? 'markdown' : 'text';
  const maxChars = input.max_chars ?? 50000;
  const imageDir = input.image_output_dir ? resolveFilePath(input.image_output_dir) : null;

  try {
    let result: ParseResult;
    let engine: string;

    const pandoc = format === 'markdown' ? findPandoc() : null;
    if (pandoc) {
      result = parseWithPandoc(resolved, imageDir);
      engine = 'pandoc';
    } else {
      result = await parseWithMammoth(resolved, format, imageDir);
      engine = 'mammoth';
    }

    let content = result.content;
    const truncated = content.length > maxChars;
    if (truncated) content = content.slice(0, maxChars);

    return JSON.stringify({
      file: path.basename(resolved),
      format,
      engine,
      char_count: content.length,
      truncated,
      content,
      images: result.images,
    });
  } catch (err: any) {
    return JSON.stringify({ error: `解析失败: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PluginModule = {
  name: 'word-parser',
  description: '解析 Word (.docx) 文件，提取文本或 Markdown 内容（支持公式和图片提取）',

  toolDefinitions: [
    {
      name: 'parse_word',
      description: '解析 Word 文档（.docx），提取纯文本或 Markdown 格式内容。Pandoc 可用时自动保留 LaTeX 公式。',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string', description: '文件路径（支持 ~/ 相对路径）' },
          format: { type: 'string', enum: ['text', 'markdown'], description: '输出格式：text（纯文本）或 markdown（保留结构），默认 text' },
          max_chars: { type: 'number', description: '最大返回字符数，默认 50000' },
          image_output_dir: { type: 'string', description: '图片输出目录路径，传入后将提取文档中的图片保存至该目录' },
        },
        required: ['file_path'],
      },
    },
  ],

  async handleTool(name, input) {
    if (name === 'parse_word') return handleParseWord(input);
    return null;
  },
};

export default plugin;
