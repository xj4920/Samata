import type { PluginModule } from '@samata/plugin-sdk';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import * as fs from 'fs';
import * as path from 'path';

function resolveFilePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME || '', filePath.slice(1));
  }
  return path.resolve(filePath);
}

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

function htmlToMarkdown(html: string): string {
  const processed = fixTablesForTurndown(html);
  const td = new TurndownService({ headingStyle: 'atx' });
  td.use(gfm);
  td.addRule('base64Images', {
    filter: (node: HTMLElement) =>
      node.nodeName === 'IMG' && (node.getAttribute('src')?.startsWith('data:') ?? false),
    replacement: () => '[图片]',
  });
  return td.turndown(processed);
}

async function handleParseWord(input: { file_path: string; format?: string; max_chars?: number }): Promise<string> {
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

  try {
    let content: string;

    if (format === 'text') {
      const result = await mammoth.extractRawText({ path: resolved });
      content = result.value;
    } else {
      const result = await mammoth.convertToHtml({ path: resolved });
      content = htmlToMarkdown(result.value);
    }

    const truncated = content.length > maxChars;
    if (truncated) content = content.slice(0, maxChars);

    return JSON.stringify({
      file: path.basename(resolved),
      format,
      char_count: content.length,
      truncated,
      content,
    });
  } catch (err: any) {
    return JSON.stringify({ error: `解析失败: ${err.message}` });
  }
}

const plugin: PluginModule = {
  name: 'word-parser',
  description: '解析 Word (.docx) 文件，提取文本或 Markdown 内容',

  toolDefinitions: [
    {
      name: 'parse_word',
      description: '解析 Word 文档（.docx），提取纯文本或 Markdown 格式内容。',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string', description: '文件路径（支持 ~/ 相对路径）' },
          format: { type: 'string', enum: ['text', 'markdown'], description: '输出格式：text（纯文本）或 markdown（保留结构），默认 text' },
          max_chars: { type: 'number', description: '最大返回字符数，默认 50000' },
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
