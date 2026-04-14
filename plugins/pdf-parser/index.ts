import type { PluginModule } from '@samata/plugin-sdk';
import * as fs from 'fs';
import * as path from 'path';

function resolveFilePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME || '', filePath.slice(1));
  }
  return path.resolve(filePath);
}

async function handleParsePdf(input: { file_path: string; max_chars?: number }): Promise<string> {
  const resolved = resolveFilePath(input.file_path);
  if (!fs.existsSync(resolved)) {
    return JSON.stringify({ error: `文件不存在: ${resolved}` });
  }

  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.pdf') {
    return JSON.stringify({ error: `不支持的格式 "${ext}"，仅支持 .pdf` });
  }

  const maxChars = input.max_chars ?? 100000;

  try {
    const pdfParse = (await import('pdf-parse')).default;
    const buffer = fs.readFileSync(resolved);
    const data = await pdfParse(buffer);

    let content = data.text;
    const truncated = content.length > maxChars;
    if (truncated) content = content.slice(0, maxChars);

    return JSON.stringify({
      file: path.basename(resolved),
      pages: data.numpages,
      char_count: content.length,
      truncated,
      content,
    });
  } catch (err: any) {
    return JSON.stringify({ error: `PDF 解析失败: ${err.message}` });
  }
}

const plugin: PluginModule = {
  name: 'pdf-parser',
  description: '解析 PDF 文件，提取文本内容',

  toolDefinitions: [
    {
      name: 'parse_pdf',
      description: '解析 PDF 文件，提取文本内容。',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_path: { type: 'string', description: '文件路径（支持 ~/ 相对路径）' },
          max_chars: { type: 'number', description: '最大返回字符数，默认 100000' },
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
