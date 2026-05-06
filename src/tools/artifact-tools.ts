import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import type { DownloadFileInput, WriteArtifactInput } from '../llm/tool-types.js';
import { downloadFileArtifact, writeArtifact } from '../commands/artifact.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'write_artifact',
    description: '将文本内容写入临时附件文件，保存到 /tmp/samata 下，适合生成 CSV、TXT、Markdown 等待发送给用户的文件。只用于文本内容；不要用它写 PDF、图片、Excel、Word 等二进制文件。',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: { type: 'string', description: '文件名，如 report.csv 或 提醒事项.md' },
        content: { type: 'string', description: '要写入文件的文本内容' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'download_file',
    description: '下载 URL 指向的二进制文件并保存为本地临时文件。遇到 PDF、Excel、Word、图片等文件 URL 时，必须先用本工具下载，再把返回的 path 交给 parse_pdf、parse_excel、parse_word 或发送工具；不要用 http_request 或 write_artifact 下载 PDF。',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: '要下载的 http/https 文件 URL' },
        filename: { type: 'string', description: '可选文件名；不填时从响应头或 URL 自动推断' },
        headers: {
          type: 'object' as const,
          description: '请求头（可选），例如 User-Agent、Referer',
          additionalProperties: { type: 'string' },
        },
        timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
      },
      required: ['url'],
    },
  },
];

function resolveInput(input: any): WriteArtifactInput {
  if (typeof input?.filename === 'string' && typeof input?.content === 'string') return input;
  if (typeof input?._raw === 'string') {
    try {
      const parsed = JSON.parse(input._raw);
      if (typeof parsed?.filename === 'string' && typeof parsed?.content === 'string') return parsed;
    } catch { /* fall through */ }
  }
  throw new Error('参数缺失：需要 filename 和 content');
}

function handleWriteArtifact(input: any): string {
  return JSON.stringify(writeArtifact(resolveInput(input)));
}

function resolveDownloadInput(input: any): DownloadFileInput {
  if (typeof input?.url === 'string') return input;
  if (typeof input?._raw === 'string') {
    try {
      const parsed = JSON.parse(input._raw);
      if (typeof parsed?.url === 'string') return parsed;
    } catch { /* fall through */ }
  }
  throw new Error('参数缺失：需要 url');
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'write_artifact': return handleWriteArtifact(input as WriteArtifactInput);
    case 'download_file': return JSON.stringify(await downloadFileArtifact(resolveDownloadInput(input)));
    default: return null;
  }
}
