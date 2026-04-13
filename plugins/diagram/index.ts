import type { PluginModule } from '@samata/plugin-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

const ARTIFACT_DIR = path.join(os.tmpdir(), 'samata');

function ensureArtifactDir(): string {
  if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  return ARTIFACT_DIR;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface RenderDiagramInput {
  code: string;
  theme?: string;
  width?: number;
  background?: string;
}

async function handleRenderDiagram(input: RenderDiagramInput): Promise<string> {
  const theme = input.theme ?? 'default';
  const width = input.width ?? 1200;
  const background = input.background ?? 'white';

  let puppeteer: any;
  try {
    puppeteer = await import('puppeteer');
  } catch {
    return JSON.stringify({ error: 'puppeteer 未安装，请执行 npm install puppeteer' });
  }

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
  mermaid.initialize({ startOnLoad: true, theme: '${escapeHtml(theme)}' });
</script>
</head>
<body style="background:${escapeHtml(background)};margin:0;padding:20px;display:inline-block">
<pre class="mermaid">${input.code}</pre>
</body></html>`;

  const outPath = path.join(ensureArtifactDir(), `diagram_${randomUUID()}.png`);

  let browser: any;
  try {
    browser = await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    await page.waitForFunction(
      () => document.querySelector('.mermaid svg') !== null,
      { timeout: 15000 },
    );

    const svgElement = await page.$('.mermaid svg');
    if (!svgElement) {
      return JSON.stringify({ error: 'Mermaid 渲染失败：未找到 SVG 元素' });
    }
    await svgElement.screenshot({ path: outPath });
  } catch (err: any) {
    return JSON.stringify({ error: `渲染失败: ${err.message}` });
  } finally {
    if (browser) await browser.close();
  }

  const stats = fs.statSync(outPath);
  return JSON.stringify({
    success: true,
    path: outPath,
    size_bytes: stats.size,
    message: `架构图已生成: ${outPath}`,
  });
}

const plugin: PluginModule = {
  name: 'diagram',
  description: '使用 Mermaid 语法渲染架构图、流程图、时序图等，输出 PNG 图片',

  toolDefinitions: [
    {
      name: 'render_diagram',
      description: '将 Mermaid DSL 代码渲染为 PNG 图片。支持 flowchart、sequence、class、ER、gantt、pie、mindmap 等所有 Mermaid 图表类型。生成后返回本地路径，需要发送给用户请继续调用 send_image。',
      input_schema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'Mermaid DSL 代码，如 flowchart LR\\n  A-->B' },
          theme: {
            type: 'string',
            enum: ['default', 'dark', 'forest', 'neutral'],
            description: 'Mermaid 主题，默认 default',
          },
          width: { type: 'number', description: '视口宽度（像素），默认 1200' },
          background: { type: 'string', description: '背景色，默认 white（也可用 transparent）' },
        },
        required: ['code'],
      },
    },
  ],

  async handleTool(name, input) {
    if (name === 'render_diagram') return handleRenderDiagram(input as RenderDiagramInput);
    return null;
  },
};

export default plugin;
