import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'web_search',
    description:
      '通过搜索引擎搜索关键词，返回搜索结果列表（标题、摘要、链接）。' +
      '适合查询公司信息、新闻、研报等公开信息。如需阅读某条结果的完整内容，再用 web_fetch 抓取对应 URL。',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回结果数量，默认 8，最大 20' },
      },
      required: ['query'],
    },
  },
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

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#0?183;/g, '·')
    .replace(/&ensp;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, m => {
      const code = parseInt(m.slice(2, -1));
      return String.fromCharCode(code);
    });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

interface SearchResult { title: string; url: string; snippet: string }

async function searchSogou(query: string, axios: any): Promise<SearchResult[]> {
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
  const resp = await axios.request({
    url,
    method: 'GET',
    timeout: 15000,
    responseType: 'text',
    transformResponse: [(data: string) => data],
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });

  if (resp.status >= 400) return [];
  const html: string = resp.data ?? '';
  const blocks = html.match(/<div class="vrwrap"[\s\S]*?(?=<div class="vrwrap"|<div id="pagebar)/g);
  if (!blocks) return [];

  const results: SearchResult[] = [];
  for (const block of blocks) {
    const titleMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/<[^>]+class="[^"]*space-txt[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/);
    const rawUrl = decodeHtmlEntities(titleMatch[1]);
    results.push({
      title: decodeHtmlEntities(stripTags(titleMatch[2])),
      url: rawUrl.startsWith('/link?') ? `https://www.sogou.com${rawUrl}` : rawUrl,
      snippet: snippetMatch ? decodeHtmlEntities(stripTags(snippetMatch[1])) : '',
    });
  }
  return results;
}

async function searchBing(query: string, axios: any): Promise<SearchResult[]> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&ensearch=0`;
  const resp = await axios.request({
    url,
    method: 'GET',
    timeout: 15000,
    responseType: 'text',
    transformResponse: [(data: string) => data],
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });

  if (resp.status >= 400) return [];
  const html: string = resp.data ?? '';
  const blocks = html.match(/<li class="b_algo"[^>]*>[\s\S]*?<\/li>/g);
  if (!blocks) return [];

  const results: SearchResult[] = [];
  for (const block of blocks) {
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)
      || block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    if (!titleMatch) continue;
    results.push({
      title: decodeHtmlEntities(stripTags(titleMatch[2])),
      url: decodeHtmlEntities(titleMatch[1]),
      snippet: snippetMatch ? decodeHtmlEntities(stripTags(snippetMatch[1])) : '',
    });
  }
  return results;
}

async function handleWebSearch(input: {
  query: string;
  count?: number;
}): Promise<string> {
  const { default: axios } = await import('axios');
  const count = Math.min(Math.max(input.count ?? 8, 1), 20);

  try {
    let results = await searchSogou(input.query, axios);
    let engine = 'sogou';
    if (results.length === 0) {
      results = await searchBing(input.query, axios);
      engine = 'bing';
    }
    if (results.length === 0) {
      return JSON.stringify({ error: '搜索引擎未返回结果，可能触发了验证码或网络异常', query: input.query });
    }
    return JSON.stringify({ query: input.query, engine, results: results.slice(0, count) });
  } catch (err: any) {
    return JSON.stringify({ error: err.message || 'search failed', query: input.query });
  }
}

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
      const hint = [403, 503, 521, 522, 523, 525].includes(resp.status)
        ? '该站点有反爬/CDN 防护，不要通过浏览器工具重试同一站点；建议基于已有知识回答，或搜索相关信息。'
        : undefined;
      return JSON.stringify({
        error: `HTTP ${resp.status}`,
        url: input.url,
        ...(hint && { hint }),
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
    case 'web_search':
      return handleWebSearch(input);
    case 'web_fetch':
      return handleWebFetch(input);
    default:
      return null;
  }
}
