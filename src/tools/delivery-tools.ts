import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import type { SendFileInput, SendImageInput } from '../llm/tool-types.js';
import { sendFileToCurrentChannel, sendImageToCurrentChannel } from '../commands/delivery.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'send_file',
    description: '把本地文件发送到当前对话。适合在 write_artifact 生成 CSV、TXT、Markdown 等附件后调用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '要发送的本地文件路径，优先使用 write_artifact 返回的 /tmp/samata 路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'send_image',
    description: '把本地图片发送到当前对话。适合在 markdown_to_image 生成 PNG 后调用。',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '要发送的本地图片路径，通常来自 markdown_to_image 返回的 path' },
      },
      required: ['path'],
    },
  },
];

export async function handleTool(name: string, input: any, ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'send_file':
      return JSON.stringify(await sendFileToCurrentChannel(input as SendFileInput, ctx?.deliveryContext));
    case 'send_image':
      return JSON.stringify(await sendImageToCurrentChannel(input as SendImageInput, ctx?.deliveryContext));
    default:
      return null;
  }
}
