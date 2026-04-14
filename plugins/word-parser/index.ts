import type { PluginModule } from '@samata/plugin-sdk';
import mammoth from 'mammoth';
import * as fs from 'fs';
import * as path from 'path';

function resolveFilePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME || '', filePath.slice(1));
  }
  return path.resolve(filePath);
}

function htmlToSimpleMarkdown(html: string): string {
  return html
    .replace(/<h(\d)[^>]*>(.*?)<\/h\1>/gi, (_m, level, text) => '#'.repeat(+level) + ' ' + text + '\n\n')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<li>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
      content = htmlToSimpleMarkdown(result.value);
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
