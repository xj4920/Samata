import TurndownService from 'turndown';

export interface WechatArticleResult {
  title: string;
  author: string;
  account_name: string;
  publish_time: string;
  content_markdown: string;
  url: string;
}

function extractJsVar(html: string, varName: string): string {
  const patterns = [
    new RegExp(`var\\s+${varName}\\s*=\\s*"([^"]*)"`, 's'),
    new RegExp(`var\\s+${varName}\\s*=\\s*'([^']*)'`, 's'),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1].replace(/\\x26/g, '&').replace(/\\x0a/g, '\n').replace(/\\n/g, '\n').trim();
  }
  return '';
}

function extractMetaContent(html: string, property: string): string {
  const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m = html.match(re);
  return m?.[1]?.trim() ?? '';
}

export async function fetchWechatArticle(url: string): Promise<WechatArticleResult> {
  if (!url.includes('mp.weixin.qq.com')) {
    throw new Error('URL 不是微信公众号文章链接（需包含 mp.weixin.qq.com）');
  }

  const { default: axios } = await import('axios');
  const resp = await axios.request({
    url,
    method: 'GET',
    timeout: 20000,
    responseType: 'text',
    transformResponse: [(data: string) => data],
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    maxRedirects: 5,
    validateStatus: () => true,
  });

  if (resp.status >= 400) {
    throw new Error(`请求失败: HTTP ${resp.status}`);
  }

  const html: string = resp.data;

  // Extract metadata from JS vars and meta tags
  const title = extractJsVar(html, 'msg_title')
    || extractMetaContent(html, 'og:title')
    || '';
  const author = extractJsVar(html, 'author')
    || extractMetaContent(html, 'article:author')
    || '';
  const accountName = extractJsVar(html, 'nickname')
    || extractMetaContent(html, 'og:article:author')
    || '';

  // publish_time: try JS var first, then meta, then regex on create_time
  let publishTime = extractJsVar(html, 'publish_time')
    || extractJsVar(html, 'create_time');
  if (!publishTime) {
    const tMatch = html.match(/var\s+ct\s*=\s*"(\d+)"/);
    if (tMatch?.[1]) publishTime = tMatch[1];
  }
  // Convert unix timestamp to readable format
  if (publishTime && /^\d{9,11}$/.test(publishTime)) {
    const d = new Date(parseInt(publishTime) * 1000);
    publishTime = d.toISOString().slice(0, 19).replace('T', ' ');
  }

  // Extract article body with cheerio
  const { load } = await import('cheerio');
  const $ = load(html);
  const contentEl = $('#js_content');

  if (contentEl.length === 0) {
    // Article may be deleted or require login
    if (html.includes('该内容已被发布者删除') || html.includes('此内容被投诉')) {
      throw new Error('文章已被删除或被投诉下架');
    }
    if (html.includes('环境异常') || html.includes('请在微信客户端打开')) {
      throw new Error('需要在微信客户端中打开，或触发了访问限制');
    }
    throw new Error('未找到文章正文内容');
  }

  // Fix lazy-loaded images: data-src -> src
  contentEl.find('img[data-src]').each((_, el) => {
    const dataSrc = $(el).attr('data-src');
    if (dataSrc) $(el).attr('src', dataSrc);
  });

  // Remove SVG placeholders used for lazy-loading
  contentEl.find('svg').remove();

  // Remove style tags within content
  contentEl.find('style').remove();

  const bodyHtml = contentEl.html() || '';

  // Convert to Markdown
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  // @ts-expect-error - no @types/turndown-plugin-gfm
  const { gfm } = await import('turndown-plugin-gfm');
  turndown.use(gfm);

  // Skip images that are just tracking pixels or emoji
  turndown.addRule('skipTinyImages', {
    filter: (node) => {
      if (node.nodeName !== 'IMG') return false;
      const w = node.getAttribute('width');
      const h = node.getAttribute('height');
      if (w && parseInt(w) <= 1) return true;
      if (h && parseInt(h) <= 1) return true;
      return false;
    },
    replacement: () => '',
  });

  const markdown = turndown.turndown(bodyHtml).trim();

  // Cap output length
  const maxLen = 50000;
  const contentMarkdown = markdown.length > maxLen
    ? markdown.slice(0, maxLen) + `\n\n...(已截断，原文约 ${markdown.length} 字符)`
    : markdown;

  return {
    title,
    author,
    account_name: accountName,
    publish_time: publishTime || '',
    content_markdown: contentMarkdown,
    url,
  };
}
