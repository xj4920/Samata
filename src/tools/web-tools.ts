import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'web_fetch',
    description:
      '抓取网页 URL，返回提取后的可读文本（Markdown 格式）。适合获取新闻、研报、公告等网页正文内容。' +
      '注意：此工具仅用于抓取 HTML 网页文本，不要用它下载 PDF/Excel/Word/图片等二进制文件；' +
      '二进制文件请使用 download_file。',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: '要抓取的网页 URL' },
        timeout: { type: 'number', description: '超时时间（毫秒），默认 15000' },
      },
      required: ['url'],
    },
  },
];

async function handleWebFetch(input: {
  url: string;
  timeout?: number;
}): Promise<string> {
  const { default: axios } = await import('axios');
  const timeout = input.timeout ?? 15000;

  try {
    const resp = await axios.request({
      url: input.url,
      method: 'GET',
      timeout,
      responseType: 'text',
      transformResponse: [(data) => data],
      validateStatus: () => true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; SamataBot/1.0; +https://samata.ai)',
      },
      maxRedirects: 5,
    });

    if (resp.status >= 400) {
      return JSON.stringify({
        error: `HTTP ${resp.status}`,
        url: input.url,
      });
    }

    const rawBody: string =
      typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    const contentType: string = String(
      resp.headers['content-type'] ?? ''
    ).toLowerCase();

    // Only convert HTML pages; pass through JSON/XML/text as-is
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      const TurndownService = (await import('turndown')).default;
      // @ts-expect-error - no @types/turndown-plugin-gfm
      const { default: turndownPluginGfm } = await import('turndown-plugin-gfm');
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '*',
      });
      turndown.use(turndownPluginGfm);
      const markdown = turndown.turndown(rawBody);
      const maxLen = 30000;
      const truncated =
        markdown.length > maxLen
          ? markdown.slice(0, maxLen) +
            `\n\n...(已截断，原始长度约 ${markdown.length} 字符)`
          : markdown;

      return JSON.stringify({
        url: input.url,
        content_type: 'text/markdown',
        text: truncated,
      });
    }

    // Non-HTML: return as text (JSON / XML / plain text)
    const maxLen = 30000;
    const truncated =
      rawBody.length > maxLen
        ? rawBody.slice(0, maxLen) +
          `\n...(已截断，原始长度 ${rawBody.length} 字节)`
        : rawBody;

    return JSON.stringify({
      url: input.url,
      content_type: contentType || 'text/plain',
      text: truncated,
    });
  } catch (err: any) {
    return JSON.stringify({
      error: err.message || 'fetch failed',
      url: input.url,
    });
  }
}

export async function handleTool(
  name: string,
  input: any,
  _ctx?: ToolContext
): Promise<string | null> {
  switch (name) {
    case 'web_fetch':
      return handleWebFetch(input);
    default:
      return null;
  }
}
