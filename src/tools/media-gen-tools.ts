import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import type { GenerateImageInput, GenerateVideoInput } from '../llm/tool-types.js';
import { generateImage, generateVideo } from '../commands/media-gen.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'generate_image',
    description: '使用 MiniMax 文生图模型根据文字描述生成图片。生成后返回本地路径，需要发送给用户请继续调用 send_image。',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: '图片描述（最多 1500 字符），尽量用英文以获得更好效果' },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'],
          description: '宽高比，默认 1:1',
        },
        count: { type: 'number', description: '生成数量（1-9），默认 1', minimum: 1, maximum: 9 },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_video',
    description: '使用 MiniMax 文生视频模型根据文字描述生成 6 秒短视频。生成耗时约 1-3 分钟，返回本地 .mp4 路径，需要发送给用户请继续调用 send_file。注意：如果遇到配额限制或参数错误，不要重试，直接告知用户。',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: '视频描述（最多 2000 字符），可用 [Push in]、[Pan left] 等指令控制镜头' },
      },
      required: ['prompt'],
    },
  },
];

async function handleGenerateImage(input: GenerateImageInput): Promise<string> {
  try {
    const result = await generateImage(input.prompt, {
      aspectRatio: input.aspect_ratio,
      count: input.count,
    });
    return JSON.stringify({
      success: true,
      paths: result.paths,
      count: result.paths.length,
      model: result.model,
      message: `已生成 ${result.paths.length} 张图片`,
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

async function handleGenerateVideo(input: GenerateVideoInput): Promise<string> {
  try {
    const result = await generateVideo(input.prompt);
    return JSON.stringify({
      success: true,
      path: result.path,
      model: result.model,
      task_id: result.taskId,
      width: result.width,
      height: result.height,
      message: `视频已生成: ${result.path}`,
    });
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'generate_image': return handleGenerateImage(input as GenerateImageInput);
    case 'generate_video': return handleGenerateVideo(input as GenerateVideoInput);
    default: return null;
  }
}
