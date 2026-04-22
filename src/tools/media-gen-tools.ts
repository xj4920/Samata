import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import type { GenerateImageInput, GenerateVideoInput } from '../llm/tool-types.js';
import { generateImage, generateVideo } from '../commands/media-gen.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'generate_image',
    description: '使用 MiniMax 文生图模型根据文字描述生成图片。支持图生图：传入 reference_image 参考人物图片可保持人物特征一致。生成后返回本地路径，需要发送给用户请继续调用 send_image。',
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
        reference_image: { type: 'string', description: '参考人物图片的本地路径（图生图模式），保持人物外貌一致生成新场景' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_video',
    description: [
      '使用 MiniMax Hailuo 2.3 生成短视频，支持文生视频(T2V)和图生视频(I2V)两种模式。配额有限，请谨慎使用。生成耗时约 1-3 分钟，返回本地 .mp4 路径，需要发送给用户请继续调用 send_file。遇到错误不要重试，直接告知用户。',
      '- T2V 模式：只传 prompt，使用 MiniMax-Hailuo-2.3',
      '- I2V 模式：传 first_frame_image + prompt，使用 MiniMax-Hailuo-2.3-Fast（图片作为视频首帧，prompt 描述运动变化即可）',
      '',
      'Prompt 写作公式：主体 + 场景空间 + 动作/变化 + 镜头运动 + 美感氛围。',
      '- 镜头指令用 [指令] 语法：[推进] [拉远] [左摇] [右摇] [上升] [下降] [左移] [右移] [上摇] [下摇] [变焦推近] [变焦拉远] [晃动] [跟随] [固定]',
      '- 组合运镜：同一 [] 内多指令同时生效，如 [左摇,上升]；前后出现的指令按顺序生效',
      '- 为镜头增加时序描述可获得更大镜头动态，如"镜头先缓缓下降，之后在下降中向右环绕"',
      '- 加入色调/氛围词（暖色调、阴郁、写实、科幻等）可精确控制美学风格',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: '视频描述（最多 2000 字符）。T2V 写法：主体+场景+动作+镜头+氛围；I2V 写法：首帧中主体+运动/变化+镜头' },
        first_frame_image: { type: 'string', description: '本地图片路径，作为视频首帧（I2V 模式）。支持 JPG/PNG/WebP，<20MB。传入此参数自动切换为图生视频' },
        duration: { type: 'number', enum: [6, 10], description: '视频时长（秒），默认 6。10 秒仅支持 768P' },
        resolution: { type: 'string', enum: ['768P', '1080P'], description: '分辨率，默认 768P。1080P 仅支持 6 秒' },
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
      referenceImage: input.reference_image,
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
    const result = await generateVideo(input.prompt, {
      duration: input.duration,
      resolution: input.resolution,
      firstFrameImage: input.first_frame_image,
    });
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
