/**
 * wiki-compile.ts
 * Compiles imported documents into a linked wiki layer (aggregation index, not lossy summaries).
 */
import fs from 'fs';
import path from 'path';
import { getDreamProvider, getProviderByName } from '../llm/provider.js';
import { getAgentFsName } from '../commands/document-import.js';
import { getDb } from '../db/connection.js';
import { log } from '../utils/logger.js';

import type { LLMProvider, ProviderName } from '../llm/provider.js';

const WIKI_ROOT = path.resolve(process.cwd(), 'data/wiki');

const SINGULAR: Record<string, string> = {
  entities: 'entity',
  concepts: 'concept',
  summaries: 'summary',
  insights: 'insight',
};

const PLURAL: Record<string, string> = {
  entity: 'entities',
  concept: 'concepts',
  summary: 'summaries',
  insight: 'insights',
};

function toSingular(plural: string): string {
  return SINGULAR[plural] || plural.replace(/s$/, '');
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++;
      queue.shift()!();
    }
  }

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () =>
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      queue.push(run);
      next();
    });
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

export function getWikiDir(agentId: string): string {
  return path.join(WIKI_ROOT, getAgentFsName(agentId));
}

function ensureWikiDirs(agentId: string): string {
  const base = getWikiDir(agentId);
  for (const sub of ['entities', 'concepts', 'summaries', 'insights']) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
  return base;
}

export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled';
}

// ---------------------------------------------------------------------------
// Page parse / merge
// ---------------------------------------------------------------------------

interface ParsedPage {
  title: string;
  category: string;
  sources: string[];
  related: string[];
  sections: Map<string, string>;
}

function stripLinks(label: string): string {
  return label.replace(/\[\[([^\]]+)\]\]/g, '$1');
}

function parseRelated(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed) as string[]; } catch { /* */ }
  }
  return trimmed.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function parsePage(content: string): ParsedPage {
  const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
  const catMatch = content.match(/^category:\s*(\w+)\s*$/m);
  const relatedMatch = content.match(/^related:\s*(.+)$/m);

  const sources: string[] = [];
  const sourcesBlock = content.match(/^sources:\s*\n((?:\s+-\s*.+\n?)*)/m);
  if (sourcesBlock) {
    for (const line of sourcesBlock[1].split('\n')) {
      const m = line.match(/^\s+-\s*"?(.+?)"?\s*$/);
      if (m) sources.push(m[1]);
    }
  } else {
    const single = content.match(/^source:\s*"?(.+?)"?\s*$/m);
    if (single) sources.push(single[1]);
  }

  const sections = new Map<string, string>();
  const bodyStart = content.indexOf('\n---\n');
  const body = bodyStart >= 0 ? content.slice(bodyStart + 5) : content;

  const mentionsMatch = body.match(/## 文档提及\n([\s\S]*?)(?=\n## |\s*$)/);
  const mentionsBlock = mentionsMatch?.[1] || body;

  const sectionRe = /^### (.+)$/gm;
  let match: RegExpExecArray | null;
  const headers: Array<{ label: string; headerStart: number; contentStart: number }> = [];
  while ((match = sectionRe.exec(mentionsBlock)) !== null) {
    headers.push({ label: stripLinks(match[1].trim()), headerStart: match.index, contentStart: match.index + match[0].length });
  }

  if (headers.length === 0 && mentionsBlock.trim()) {
    sections.set('(legacy)', mentionsBlock.trim());
  } else {
    for (let i = 0; i < headers.length; i++) {
      const start = headers[i].contentStart;
      const end = i + 1 < headers.length ? headers[i + 1].headerStart : mentionsBlock.length;
      sections.set(headers[i].label, mentionsBlock.slice(start, end).trim());
    }
  }

  return {
    title: titleMatch?.[1] || 'untitled',
    category: catMatch?.[1] || 'entity',
    sources,
    related: parseRelated(relatedMatch?.[1]),
    sections,
  };
}

function renderRelatedSection(related: string[]): string {
  if (related.length === 0) return '';
  return '## 关联\n\n' + related.map(r => `- [[${r}]]`).join('\n');
}

function buildBody(sections: Map<string, string>, related: string[]): string {
  const mentionLines = [...sections.entries()]
    .map(([label, text]) => `### ${label}\n${text}`)
    .join('\n\n');
  const parts = ['## 文档提及', mentionLines];
  const rel = renderRelatedSection(related);
  if (rel) parts.push(rel);
  return parts.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Index & log
// ---------------------------------------------------------------------------

export function loadIndex(agentId: string): string {
  const indexPath = path.join(getWikiDir(agentId), 'index.md');
  if (fs.existsSync(indexPath)) return fs.readFileSync(indexPath, 'utf-8');
  return '';
}

function collectPageNames(wikiDir: string): string {
  const lines: string[] = [];
  for (const category of ['entities', 'concepts'] as const) {
    const catDir = path.join(wikiDir, category);
    if (!fs.existsSync(catDir)) continue;
    const files = fs.readdirSync(catDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) continue;
    const names: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(catDir, file), 'utf-8');
      const m = content.match(/^title:\s*"?(.+?)"?\s*$/m);
      names.push(m?.[1] || file.replace('.md', ''));
    }
    lines.push(`已有 ${category}: ${names.join(', ')}`);
  }
  return lines.join('\n');
}

function writeIndex(wikiDir: string, content: string): void {
  fs.writeFileSync(path.join(wikiDir, 'index.md'), content, 'utf-8');
}

function appendLog(wikiDir: string, entry: string): void {
  const logPath = path.join(wikiDir, 'log.md');
  const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(logPath, existing + `## [${dateStr}] ${entry}\n\n`, 'utf-8');
}

interface WikiPage {
  name: string;
  content: string;
  related?: string[];
  action?: string;
}

function writePage(
  dir: string,
  category: string,
  page: WikiPage,
  source: string,
  docTitle: string,
): void {
  const slug = toSlug(page.name);
  const filePath = path.join(dir, category, `${slug}.md`);
  const sourceLabel = docTitle;
  const escapedTitle = page.name.replace(/"/g, '\\"');
  const catSingular = toSingular(category);
  const now = new Date().toISOString().slice(0, 19);

  let sources: string[];
  let related: string[];
  let sections: Map<string, string>;

  if (fs.existsSync(filePath)) {
    const existing = parsePage(fs.readFileSync(filePath, 'utf-8'));
    existing.sections.set(sourceLabel, page.content);
    if (!existing.sources.includes(source)) existing.sources.push(source);
    sources = existing.sources;
    related = [...new Set([...existing.related, ...(page.related || [])])];
    sections = existing.sections;
  } else {
    sources = [source];
    related = page.related || [];
    sections = new Map([[sourceLabel, page.content]]);
  }

  const frontmatter = [
    '---',
    `title: "${escapedTitle}"`,
    `category: ${catSingular}`,
    'sources:',
    ...sources.map(s => `  - "${s}"`),
    related.length ? `related: ${JSON.stringify(related)}` : null,
    `updated_at: ${now}`,
    '---',
    '',
  ].filter(Boolean).join('\n');

  fs.writeFileSync(filePath, frontmatter + buildBody(sections, related), 'utf-8');
}

export function rebuildIndex(wikiDir: string): string {
  const sections: string[] = ['# Wiki Index\n'];
  for (const category of ['entities', 'concepts', 'summaries', 'insights']) {
    const catDir = path.join(wikiDir, category);
    if (!fs.existsSync(catDir)) continue;
    const files = fs.readdirSync(catDir).filter(f => f.endsWith('.md')).sort();
    if (files.length === 0) continue;
    sections.push(`## ${category.charAt(0).toUpperCase() + category.slice(1)}\n`);
    for (const file of files) {
      const content = fs.readFileSync(path.join(catDir, file), 'utf-8');
      const parsed = parsePage(content);
      const relHint = parsed.related.length ? ` — related: ${parsed.related.slice(0, 5).join(', ')}` : '';
      const firstMention = [...parsed.sections.values()][0]?.split('\n')[0]?.slice(0, 60) || '';
      sections.push(`- [${parsed.title}](${category}/${file})${relHint} — ${firstMention}`);
    }
    sections.push('');
  }
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 1.5: purge & recompile
// ---------------------------------------------------------------------------

/** Remove all sections sourced from docTitle; delete page if empty. */
export function purgeDocumentFromWiki(agentId: string, docTitle: string): number {
  const wikiDir = getWikiDir(agentId);
  let removed = 0;

  for (const category of ['entities', 'concepts'] as const) {
    const catDir = path.join(wikiDir, category);
    if (!fs.existsSync(catDir)) continue;

    for (const file of fs.readdirSync(catDir).filter(f => f.endsWith('.md'))) {
      const filePath = path.join(catDir, file);
      const parsed = parsePage(fs.readFileSync(filePath, 'utf-8'));

      if (!parsed.sections.has(docTitle)) continue;

      parsed.sections.delete(docTitle);
      const sourceTag = `ingest:${docTitle}`;
      parsed.sources = parsed.sources.filter(s => s !== sourceTag);
      removed++;

      if (parsed.sections.size === 0) {
        fs.unlinkSync(filePath);
        continue;
      }

      const frontmatter = [
        '---',
        `title: "${parsed.title.replace(/"/g, '\\"')}"`,
        `category: ${parsed.category}`,
        'sources:',
        ...parsed.sources.map(s => `  - "${s}"`),
        parsed.related.length ? `related: ${JSON.stringify(parsed.related)}` : null,
        `updated_at: ${new Date().toISOString().slice(0, 19)}`,
        '---',
        '',
      ].filter(Boolean).join('\n');

      fs.writeFileSync(filePath, frontmatter + buildBody(parsed.sections, parsed.related), 'utf-8');
    }
  }

  const summaryDir = path.join(wikiDir, 'summaries');
  if (fs.existsSync(summaryDir)) {
    for (const file of fs.readdirSync(summaryDir)) {
      const content = fs.readFileSync(path.join(summaryDir, file), 'utf-8');
      const t = content.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1];
      if (t === docTitle) {
        fs.unlinkSync(path.join(summaryDir, file));
        removed++;
      }
    }
  }

  return removed;
}

export async function recompileDocument(agentId: string, docIdPrefix: string): Promise<boolean> {
  const agentFsName = getAgentFsName(agentId);
  const parsedPath = path.resolve(process.cwd(), 'data/documents', agentFsName, docIdPrefix.slice(0, 8), 'parsed.md');
  if (!fs.existsSync(parsedPath)) {
    log.warn(`[wiki-compile] recompile: parsed.md not found for ${docIdPrefix}`);
    return false;
  }

  const content = fs.readFileSync(parsedPath, 'utf-8');
  const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
  const title = titleMatch?.[1] || docIdPrefix;

  purgeDocumentFromWiki(agentId, title);

  const db = getDb();
  db.prepare('UPDATE documents SET wiki_compiled_hash = NULL WHERE id LIKE ? AND agent_id = ?')
    .run(`${docIdPrefix.slice(0, 8)}%`, agentId);

  return compileDocumentToWiki(agentId, title, content, docIdPrefix);
}

// ---------------------------------------------------------------------------
// LLM compilation
// ---------------------------------------------------------------------------

const COMPILE_SYSTEM_PROMPT = `你是知识编译器。严格从**当前文档原文**中提取结构化知识，禁止添加任何文档中不存在的信息。

## 核心约束

1. **严禁幻觉**：只能使用文档原文中明确出现的事实。
2. **只提取当前文档的新信息**：已有 wiki 中的旧提及由系统自动保留合并，不要把已有 wiki 内容复制到输出。
3. **不确定则不写**。
4. 每个实体/概念输出 **mention**：当前文档中对该实体的一句话概要（不超过 100 字），末尾标注 [来源: 文档标题]。
5. **related**：文档中明确共现的其他实体/概念名称（用于跨页链接），无则空数组。

## 输出格式

返回严格 JSON（不要 markdown code fence）：
{
  "summary": "文档核心摘要（100-200字）",
  "entities": [
    {"name": "实体名", "content": "一句话概要 [来源: 文档标题]", "related": ["关联实体或概念名"], "action": "create"}
  ],
  "concepts": [
    {"name": "概念名", "content": "一句话定义 [来源: 文档标题]", "related": [], "action": "create"}
  ],
  "contradictions": []
}

## 提取规则

- entities: 具体人名、机构、产品、客户名
- concepts: 业务规则、流程、指标定义
- action: 已有列表中有同名或近似名用 "create"（系统会 merge section），不要输出 replace 全文
- **实体命名**：复用已有列表中的名称，勿造近义新名
- 不提取泛化词（"客户"、"系统"）`;

interface CompileResult {
  summary?: string;
  entities?: WikiPage[];
  concepts?: WikiPage[];
  contradictions?: string[];
}

interface CompileOptions {
  skipRebuildIndex?: boolean;
  provider?: LLMProvider;
  model?: string;
}

export async function compileDocumentToWiki(
  agentId: string,
  docTitle: string,
  docContent: string,
  docIdPrefix: string,
  options?: CompileOptions,
): Promise<boolean> {
  try {
    const wikiDir = ensureWikiDirs(agentId);
    const existingNames = collectPageNames(wikiDir);
    const truncatedContent = docContent.length > 8000
      ? docContent.slice(0, 8000) + '\n\n...(truncated)'
      : docContent;

    const userMessage = [
      `## 文档标题: ${docTitle}`,
      '',
      '## 已有 wiki 实体和概念（用于复用命名）:',
      existingNames || '(空)',
      '',
      '## 文档内容:',
      truncatedContent,
    ].join('\n');

    const llm = options?.provider && options?.model
      ? { provider: options.provider, model: options.model }
      : getDreamProvider();

    const result = await llm.provider.createMessage({
      model: llm.model,
      max_tokens: 4000,
      system: COMPILE_SYSTEM_PROMPT,
      tools: [],
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlocks = result.content.filter((b: any) => b.type === 'text');
    const rawText = textBlocks.map((b: any) => b.text).join('\n').trim();
    if (!rawText) {
      log.warn(`[wiki-compile] ${docTitle}: LLM 返回空内容`);
      return false;
    }

    const jsonStr = rawText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    let compiled: CompileResult;
    try {
      compiled = JSON.parse(jsonStr);
    } catch {
      try {
        compiled = JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        log.error(`[wiki-compile] ${docTitle}: JSON 解析失败`);
        return false;
      }
    }

    if (compiled.summary) {
      const summarySlug = docIdPrefix.slice(0, 8);
      fs.writeFileSync(
        path.join(wikiDir, 'summaries', `${summarySlug}.md`),
        [
          '---',
          `title: "${docTitle.replace(/"/g, '\\"')}"`,
          'category: summary',
          `doc_id: ${docIdPrefix}`,
          `created_at: ${new Date().toISOString().slice(0, 19)}`,
          '---',
          '',
          compiled.summary,
        ].join('\n'),
        'utf-8',
      );
    }

    const source = `ingest:${docTitle}`;
    for (const entity of compiled.entities || []) {
      if (entity.name && entity.content) {
        writePage(wikiDir, 'entities', entity, source, docTitle);
      }
    }
    for (const concept of compiled.concepts || []) {
      if (concept.name && concept.content) {
        writePage(wikiDir, 'concepts', concept, source, docTitle);
      }
    }

    if (!options?.skipRebuildIndex) {
      writeIndex(wikiDir, rebuildIndex(wikiDir));
    }

    const db = getDb();
    const row = db.prepare(
      'SELECT id, content_hash FROM documents WHERE id LIKE ? AND agent_id = ?',
    ).get(`${docIdPrefix.slice(0, 8)}%`, agentId) as { id: string; content_hash: string | null } | undefined;
    if (row?.content_hash) {
      db.prepare('UPDATE documents SET wiki_compiled_hash = ? WHERE id = ?').run(row.content_hash, row.id);
    }

    appendLog(wikiDir, `ingest | ${docTitle}`);
    log.info(`[wiki-compile] ${docTitle}: ${(compiled.entities || []).length} entities, ${(compiled.concepts || []).length} concepts`);
    return true;
  } catch (err: any) {
    log.error(`[wiki-compile] ${docTitle}: ${err.message}`);
    return false;
  }
}

function selectModelForDocument(contentLength: number): { provider: LLMProvider; model: string } | undefined {
  const flashProvider = process.env.WIKI_FAST_PROVIDER;
  const flashModel = process.env.WIKI_FAST_MODEL;
  if (!flashProvider || !flashModel) return undefined;
  const threshold = parseInt(process.env.WIKI_FAST_THRESHOLD || '2000', 10);
  if (contentLength <= threshold) {
    const p = getProviderByName(flashProvider as ProviderName);
    if (p) return { provider: p, model: flashModel };
  }
  return undefined;
}

const BATCH_CONCURRENCY = parseInt(process.env.WIKI_COMPILE_CONCURRENCY || '3', 10);

export async function compileAllDocuments(agentId: string): Promise<{
  compiled: number;
  skipped: number;
  failed: number;
}> {
  const agentFsName = getAgentFsName(agentId);
  const docsDir = path.resolve(process.cwd(), 'data/documents', agentFsName);
  const wikiDir = getWikiDir(agentId);

  if (!fs.existsSync(docsDir)) return { compiled: 0, skipped: 0, failed: 0 };

  const docDirs = fs.readdirSync(docsDir).filter(d =>
    fs.statSync(path.join(docsDir, d)).isDirectory(),
  );

  const db = getDb();
  const toCompile: Array<{ docDir: string; title: string; content: string }> = [];
  let skipped = 0;

  for (const docDir of docDirs) {
    const parsedPath = path.join(docsDir, docDir, 'parsed.md');
    if (!fs.existsSync(parsedPath)) { skipped++; continue; }

    const row = db.prepare(
      'SELECT content_hash, wiki_compiled_hash FROM documents WHERE id LIKE ? AND agent_id = ?',
    ).get(`${docDir}%`, agentId) as { content_hash: string | null; wiki_compiled_hash: string | null } | undefined;

    if (row?.content_hash && row.content_hash === row.wiki_compiled_hash) {
      skipped++;
      continue;
    }

    let content: string;
    try { content = fs.readFileSync(parsedPath, 'utf-8'); } catch { skipped++; continue; }

    const title = content.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1] || docDir;
    toCompile.push({ docDir, title, content });
  }

  let compiled = 0;
  let failed = 0;
  const limit = pLimit(BATCH_CONCURRENCY);

  await Promise.allSettled(
    toCompile.map(({ docDir, title, content }) =>
      limit(async () => {
        const tier = selectModelForDocument(content.length);
        const ok = await compileDocumentToWiki(agentId, title, content, docDir, {
          skipRebuildIndex: true,
          ...(tier ? { provider: tier.provider, model: tier.model } : {}),
        });
        if (ok) compiled++;
        else failed++;
      }),
    ),
  );

  ensureWikiDirs(agentId);
  writeIndex(wikiDir, rebuildIndex(wikiDir));
  log.info(`[wiki-compile] Batch done: ${compiled} compiled, ${skipped} skipped, ${failed} failed`);
  return { compiled, skipped, failed };
}

export function writeWikiPage(
  agentId: string,
  title: string,
  category: string,
  content: string,
  relatedPages?: string[],
): { success: boolean; path?: string; error?: string } {
  try {
    const wikiDir = ensureWikiDirs(agentId);
    const catDir = category === 'comparison' ? 'insights' : (PLURAL[category] || `${category}s`);
    const slug = toSlug(title);
    const filePath = path.join(wikiDir, catDir, `${slug}.md`);
    const related = relatedPages || [];

    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `category: ${category}`,
      `source: query`,
      related.length ? `related: ${JSON.stringify(related)}` : null,
      `created_at: ${new Date().toISOString().slice(0, 19)}`,
      '---',
      '',
    ].filter(Boolean).join('\n');

    const body = content.includes('## 文档提及') ? content : `## 文档提及\n\n${content}\n\n${renderRelatedSection(related)}`;
    fs.writeFileSync(filePath, frontmatter + body, 'utf-8');
    writeIndex(wikiDir, rebuildIndex(wikiDir));
    appendLog(wikiDir, `query | ${title}`);
    return { success: true, path: `${catDir}/${slug}.md` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
