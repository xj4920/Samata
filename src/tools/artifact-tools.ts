import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import type { WriteArtifactInput } from '../llm/tool-types.js';
import { writeArtifact } from '../commands/artifact.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'write_artifact',
    description: '将文本内容写入临时附件文件，保存到 /tmp/samata 下，适合生成 CSV、TXT、Markdown 等待发送给用户的文件。',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: { type: 'string', description: '文件名，如 report.csv 或 提醒事项.md' },
        content: { type: 'string', description: '要写入文件的文本内容' },
      },
      required: ['filename', 'content'],
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

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'write_artifact': return handleWriteArtifact(input as WriteArtifactInput);
    default: return null;
  }
}
