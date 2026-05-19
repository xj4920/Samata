import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { MarkdownToImageInput } from '../llm/tool-types.js';
import { getArtifactRoot } from '../commands/artifact.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'markdown_to_image',
    description: '将 Markdown 文本渲染为 PNG 图片，保存到 /tmp/samata 并返回图片路径。此工具只负责生成图片；若要发给用户，请继续调用 send_image。\n⚠️ 布局要求：内容必须纵向排列（从上到下），严禁使用多列并排的宽表格。图片会在聊天气泡中等比缩放，过宽的图片缩放后文字会极小不可读。推荐宽高比 ≤ 2:1；如果内容含多个并列板块，请拆分为多张图或纵向堆叠。',
    input_schema: {
      type: 'object' as const,
      properties: {
        markdown: { type: 'string', description: 'Markdown 内容（纵向排列，避免多列宽表格）' },
        width: { type: 'number', description: '图片宽度（像素），默认 1000' },
        theme: { type: 'string', enum: ['light', 'dark'], description: '主题：light（默认）或 dark' },
      },
      required: ['markdown'],
    },
  },
];

// Server-side Markdown → HTML conversion (no browser JS needed)
function mdToHtml(md: string): string {
  let html = md;

  // Fenced code blocks
  const codeBlocks: string[] = [];
  html = html.replace(/```([\w]*)\n?([\s\S]*?)```/g, (_: string, lang: string, code: string) => {
    if (lang === 'mermaid') {
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre class="mermaid">${code.trimEnd()}</pre>`);
      return `\x00CODE${idx}\x00`;
    }
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .trimEnd();
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
    return `\x00CODE${idx}\x00`;
  });

  // Inline code
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`\n]+)`/g, (_: string, code: string) => {
    const escaped = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escaped}</code>`);
    return `\x01IC${idx}\x01`;
  });

  // Headings
  html = html.replace(/^###### (.+)$/mg, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/mg, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/mg, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/mg, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/mg, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/mg, '<h1>$1</h1>');

  // HR
  html = html.replace(/^[-*_]{3,}$/mg, '<hr>');

  // Blockquote
  html = html.replace(/^> (.+)$/mg, '<blockquote><p>$1</p></blockquote>');
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Bold, italic, strikethrough
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Links & images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Tables
  html = html.replace(/((?:^\|.+\|\n?)+)/mg, (tableBlock: string) => {
    const lines = tableBlock.trim().split('\n');
    if (lines.length < 2) return tableBlock;
    const isSep = (line: string) => /^[\|:\s\-]+$/.test(line);
    let result = '<table>';
    let inBody = false;
    for (const line of lines) {
      if (isSep(line)) { inBody = true; continue; }
      const cells = line.replace(/^\||\|$/g, '').split('|');
      const tag = inBody ? 'td' : 'th';
      result += '<tr>' + cells.map((c: string) => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    }
    result += '</table>';
    return result;
  });

  // Unordered lists
  html = html.replace(/((?:^[ \t]*[-*+] .+\n?)+)/mg, (block: string) => {
    const items = block.trim().split('\n').map((l: string) => {
      const m = l.match(/^[ \t]*[-*+] (.+)$/);
      return m ? `<li>${m[1]}</li>` : '';
    }).filter(Boolean).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/((?:^[ \t]*\d+\. .+\n?)+)/mg, (block: string) => {
    const items = block.trim().split('\n').map((l: string) => {
      const m = l.match(/^[ \t]*\d+\. (.+)$/);
      return m ? `<li>${m[1]}</li>` : '';
    }).filter(Boolean).join('');
    return `<ol>${items}</ol>`;
  });

  // Paragraphs
  html = html.split('\n\n').map((block: string) => {
    block = block.trim();
    if (!block) return '';
    if (/^<(h[1-6]|ul|ol|table|blockquote|pre|hr)/.test(block)) return block;
    if (/\x00CODE\d+\x00/.test(block)) return block;
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  // Restore inline codes and code blocks
  inlineCodes.forEach((c, i) => { html = html.split(`\x01IC${i}\x01`).join(c); });
  codeBlocks.forEach((c, i) => { html = html.split(`\x00CODE${i}\x00`).join(c); });

  return html;
}

function buildHtml(markdown: string, width: number, theme: 'light' | 'dark'): { html: string; hasMermaid: boolean } {
  const isDark = theme === 'dark';
  const bg = isDark ? '#1e1e2e' : '#ffffff';
  const fg = isDark ? '#cdd6f4' : '#24292f';
  const codeBg = isDark ? '#313244' : '#f6f8fa';
  const codeFg = isDark ? '#cdd6f4' : '#24292f';
  const borderColor = isDark ? '#45475a' : '#d0d7de';
  const blockquoteBg = isDark ? '#2a2a3e' : '#f6f8fa';
  const linkColor = isDark ? '#89b4fa' : '#0969da';
  const headingBorder = isDark ? '#45475a' : '#d8dee4';
  const tableBg = isDark ? '#181825' : '#f6f8fa';
  const tableRowHover = isDark ? '#2a2a3e' : '#f0f4f8';
  const blockquoteFg = isDark ? '#a6adc8' : '#57606a';

  const bodyHtml = mdToHtml(markdown);
  const hasMermaid = bodyHtml.includes('class="mermaid"');

  const mermaidScript = hasMermaid
    ? `<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true, theme: '${isDark ? 'dark' : 'default'}' });</script>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${mermaidScript}
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
  font-size: 15px;
  line-height: 1.7;
  color: ${fg};
  background: ${bg};
  padding: 32px 40px;
  width: ${width}px;
}
h1, h2, h3, h4, h5, h6 {
  margin: 1.2em 0 0.5em;
  font-weight: 600;
  line-height: 1.25;
}
h1 { font-size: 2em; border-bottom: 1px solid ${headingBorder}; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid ${headingBorder}; padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
h4 { font-size: 1em; }
h1:first-child, h2:first-child { margin-top: 0; }
p { margin: 0.75em 0; }
a { color: ${linkColor}; text-decoration: none; }
code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, "Noto Sans Mono CJK SC", "Noto Color Emoji", monospace;
  font-size: 0.875em;
  background: ${codeBg};
  color: ${codeFg};
  padding: 0.2em 0.4em;
  border-radius: 4px;
  border: 1px solid ${borderColor};
}
pre {
  background: ${codeBg};
  border: 1px solid ${borderColor};
  border-radius: 6px;
  padding: 16px;
  overflow-x: auto;
  margin: 1em 0;
}
pre code {
  background: none;
  border: none;
  padding: 0;
  font-size: 0.875em;
  line-height: 1.6;
  white-space: pre;
}
blockquote {
  background: ${blockquoteBg};
  border-left: 4px solid ${borderColor};
  padding: 8px 16px;
  margin: 1em 0;
  color: ${blockquoteFg};
  border-radius: 0 4px 4px 0;
}
blockquote p { margin: 0.25em 0; }
ul, ol { padding-left: 2em; margin: 0.75em 0; }
li { margin: 0.3em 0; }
li > ul, li > ol { margin: 0.2em 0; }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
  font-size: 0.9em;
}
th {
  background: ${tableBg};
  font-weight: 600;
  text-align: left;
  padding: 8px 12px;
  border: 1px solid ${borderColor};
}
td {
  padding: 7px 12px;
  border: 1px solid ${borderColor};
  vertical-align: top;
}
tr:nth-child(even) td { background: ${tableRowHover}; }
hr {
  border: none;
  border-top: 1px solid ${borderColor};
  margin: 1.5em 0;
}
img { max-width: 100%; border-radius: 4px; }
strong { font-weight: 600; }
em { font-style: italic; }
del { text-decoration: line-through; opacity: 0.7; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;

  return { html, hasMermaid };
}

async function handleMarkdownToImage(input: MarkdownToImageInput): Promise<string> {
  const width = input.width ?? 1000;
  const theme = input.theme ?? 'light';

  let puppeteer: any;
  try {
    puppeteer = await import('puppeteer');
  } catch {
    return JSON.stringify({ error: 'puppeteer 未安装，请执行 npm install puppeteer' });
  }

  const { html, hasMermaid } = buildHtml(input.markdown, width, theme);
  const tmpFile = path.join(getArtifactRoot(), `md_${randomUUID()}.png`);

  let browser: any;
  try {
    browser = await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height: 800, deviceScaleFactor: 3 });
    await page.setContent(html, { waitUntil: hasMermaid ? 'networkidle0' : 'domcontentloaded' });

    if (hasMermaid) {
      await page.waitForFunction(
        () => document.querySelector('.mermaid svg') !== null,
        { timeout: 15000 },
      );
    }

    let contentHeight: number = await page.evaluate(() => document.body.scrollHeight);
    let effectiveWidth = width;

    const MAX_ASPECT_RATIO = 2.5;
    if (effectiveWidth / contentHeight > MAX_ASPECT_RATIO) {
      effectiveWidth = Math.max(500, Math.round(contentHeight * MAX_ASPECT_RATIO));
      if (effectiveWidth < width) {
        await page.evaluate((w: number) => { document.body.style.width = w + 'px'; }, effectiveWidth);
        contentHeight = await page.evaluate(() => document.body.scrollHeight);
      }
    }

    await page.setViewport({ width: effectiveWidth, height: Math.max(contentHeight, 1), deviceScaleFactor: 3 });

    await page.screenshot({ path: tmpFile, fullPage: false });
  } finally {
    if (browser) await browser.close();
  }

  const stats = fs.statSync(tmpFile);
  return JSON.stringify({
    success: true,
    path: tmpFile,
    size_bytes: stats.size,
    message: `图片已生成: ${tmpFile}`,
  });
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'markdown_to_image': return handleMarkdownToImage(input as MarkdownToImageInput);
    default: return null;
  }
}
