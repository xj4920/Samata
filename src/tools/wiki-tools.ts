import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getCurrentAgent, type ToolContext } from '../llm/agents/config.js';
import { getAgentFsName } from '../commands/document-import.js';
import type { ReadWikiPageInput } from '../llm/tool-types.js';

const DATA_ROOT = path.resolve(process.cwd(), 'data');
const DEFAULT_READ_CHARS = 12000;
const MIN_READ_CHARS = 1000;
const MAX_READ_CHARS = 50000;

const PLURAL: Record<string, string> = {
  entity: 'entities',
  concept: 'concepts',
  insight: 'insights',
  comparison: 'insights',
};

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled';
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'read_wiki_page',
    description: '读取 search_knowledge 返回的 wiki 页面全文。传入 wiki[].page，例如 concepts/北向极速业务全景.md。只能读取当前 Agent 自己的 data/wiki 目录下 Markdown 页面；不要用 read_knowledge_document 读取 wiki 页面。',
    input_schema: {
      type: 'object' as const,
      properties: {
        page: { type: 'string', description: 'Wiki 页面相对路径，来自 search_knowledge 返回的 wiki[].page' },
        max_chars: { type: 'number', description: '最多返回字符数，默认 12000，最大 50000' },
      },
      required: ['page'],
    },
  },
  {
    name: 'file_to_wiki',
    description: '将对话中从知识库综合得到的关联洞察写入 Wiki。content 必须严格基于 search_knowledge 返回的结果，每条信息标注来源，严禁混入训练数据。覆盖式更新（非追加）。',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: '页面标题（简洁明确）' },
        category: {
          type: 'string',
          enum: ['entity', 'concept', 'insight', 'comparison'],
          description: '分类：entity=实体综合、concept=概念定义、insight=分析洞察、comparison=对比分析',
        },
        content: { type: 'string', description: 'Markdown 内容，包含关联说明和来源引用' },
        related_pages: {
          type: 'array',
          items: { type: 'string' },
          description: '关联的已有 wiki 页面名（可选）',
        },
      },
      required: ['title', 'category', 'content'],
    },
  },
];

function clampMaxChars(value: unknown): number {
  const n = Number(value ?? DEFAULT_READ_CHARS);
  if (!Number.isFinite(n)) return DEFAULT_READ_CHARS;
  return Math.min(Math.max(Math.floor(n), MIN_READ_CHARS), MAX_READ_CHARS);
}

function normalizeWikiPage(page: unknown): { ok: true; page: string } | { ok: false; error: string } {
  const raw = typeof page === 'string' ? page.trim() : '';
  if (!raw) return { ok: false, error: 'page 不能为空' };
  if (raw.includes('\0')) return { ok: false, error: 'page 包含非法字符' };

  const slashPath = raw.replace(/\\/g, '/');
  if (slashPath.startsWith('/') || /^[A-Za-z]:/.test(slashPath)) {
    return { ok: false, error: 'page 必须是 wiki 内的相对路径' };
  }

  const parts = slashPath.split('/').filter(part => part.length > 0 && part !== '.');
  if (parts.length === 0) return { ok: false, error: 'page 不能为空' };
  if (parts.some(part => part === '..')) {
    return { ok: false, error: 'page 不能包含 .. 路径片段' };
  }

  const normalized = path.posix.normalize(parts.join('/'));
  if (!normalized.toLowerCase().endsWith('.md')) {
    return { ok: false, error: '只能读取 Markdown wiki 页面' };
  }
  return { ok: true, page: normalized };
}

function parseWikiFrontmatter(content: string): { title?: string; category?: string } {
  if (!content.startsWith('---\n')) return {};
  const endIdx = content.indexOf('\n---', 4);
  if (endIdx === -1) return {};

  const meta: Record<string, string> = {};
  for (const line of content.slice(4, endIdx).split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!match) continue;
    meta[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return { title: meta.title, category: meta.category };
}

function ensureInside(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function handleReadWikiPage(input: ReadWikiPageInput): string {
  const agent = getCurrentAgent();
  if (!agent) {
    return JSON.stringify({ error: '当前上下文没有 Agent，无法读取 wiki 页面' });
  }

  const normalized = normalizeWikiPage(input.page);
  if (!normalized.ok) {
    return JSON.stringify({ error: normalized.error });
  }

  const wikiDir = path.resolve(DATA_ROOT, 'wiki', getAgentFsName(agent.id));
  if (!fs.existsSync(wikiDir)) {
    return JSON.stringify({ error: '当前 Agent 没有 wiki 目录' });
  }

  const targetPath = path.resolve(wikiDir, normalized.page);
  try {
    const realWikiDir = fs.realpathSync(wikiDir);
    const realTarget = fs.realpathSync(targetPath);
    if (!ensureInside(realWikiDir, realTarget)) {
      return JSON.stringify({ error: '拒绝读取当前 Agent wiki 目录外的文件' });
    }

    const stat = fs.statSync(realTarget);
    if (!stat.isFile()) {
      return JSON.stringify({ error: `未找到 wiki 页面: ${normalized.page}` });
    }

    const fullContent = fs.readFileSync(realTarget, 'utf-8');
    const maxChars = clampMaxChars(input.max_chars);
    const truncated = fullContent.length > maxChars;
    const content = truncated ? fullContent.slice(0, maxChars) : fullContent;
    const meta = parseWikiFrontmatter(fullContent);

    return JSON.stringify({
      page: normalized.page,
      title: meta.title ?? path.basename(normalized.page, '.md'),
      category: meta.category ?? path.dirname(normalized.page).replace(/^\.$/, ''),
      char_count: fullContent.length,
      returned_chars: content.length,
      truncated,
      content,
    });
  } catch {
    return JSON.stringify({ error: `未找到 wiki 页面: ${normalized.page}` });
  }
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  if (name === 'read_wiki_page') return handleReadWikiPage(input);
  if (name !== 'file_to_wiki') return null;

  const agent = getCurrentAgent();
  if (!agent) {
    return JSON.stringify({ success: false, error: '无法确定当前 Agent' });
  }

  const { title, category, content } = input as {
    title: string;
    category: string;
    content: string;
  };

  if (!title || !category || !content) {
    return JSON.stringify({ success: false, error: '缺少必要参数: title, category, content' });
  }

  try {
    const catDir = PLURAL[category] || `${category}s`;
    const wikiDir = path.join(DATA_ROOT, 'wiki', getAgentFsName(agent.id), catDir);
    fs.mkdirSync(wikiDir, { recursive: true });

    const slug = toSlug(title);
    const frontmatter = `---\ntitle: "${title.replace(/"/g, '\\"')}"\ncategory: ${category}\ncreated_at: ${new Date().toISOString().slice(0, 19)}\n---\n\n`;
    fs.writeFileSync(path.join(wikiDir, `${slug}.md`), frontmatter + content, 'utf-8');

    return JSON.stringify({ success: true, path: `${catDir}/${slug}.md` });
  } catch (err: any) {
    return JSON.stringify({ success: false, error: err.message });
  }
}
