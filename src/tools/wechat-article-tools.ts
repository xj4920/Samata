import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { fetchWechatArticle } from '../commands/wechat-article.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'read_wechat_article',
    description:
      '读取微信公众号文章内容。传入 mp.weixin.qq.com 的文章链接，返回标题、作者、公众号名、发布时间和正文（Markdown 格式）。',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: '微信公众号文章 URL（mp.weixin.qq.com）' },
      },
      required: ['url'],
    },
  },
];

export async function handleTool(
  name: string,
  input: any,
  _ctx?: ToolContext
): Promise<string | null> {
  if (name !== 'read_wechat_article') return null;

  try {
    const result = await fetchWechatArticle(input.url);
    return JSON.stringify(result);
  } catch (err: any) {
    return JSON.stringify({ error: err.message || '读取失败', url: input.url });
  }
}
