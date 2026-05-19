/**
 * wiki-compile.ts
 * Utilities for the file_to_wiki tool and wiki page management.
 */
import fs from 'fs';
import path from 'path';
import { getAgentFsName } from '../commands/document-import.js';
import { getDb } from '../db/connection.js';

const WIKI_ROOT = path.resolve(process.cwd(), 'data/wiki');

const PLURAL: Record<string, string> = {
  entity: 'entities',
  concept: 'concepts',
  summary: 'summaries',
  insight: 'insights',
};

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
// Source citation linking: convert [来源: xxx] to clickable markdown links
// ---------------------------------------------------------------------------

let _docLinkCache: { agentId: string; map: Map<string, string> } | null = null;

function getDocLinkMap(agentId: string): Map<string, string> {
  if (_docLinkCache && _docLinkCache.agentId === agentId) return _docLinkCache.map;
  const db = getDb();
  const rows = db.prepare(
    'SELECT title, stored_path FROM documents WHERE agent_id = ? AND stored_path IS NOT NULL',
  ).all(agentId) as { title: string; stored_path: string }[];
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.title, r.stored_path);
  }
  _docLinkCache = { agentId, map };
  return map;
}

export function invalidateDocLinkCache(): void {
  _docLinkCache = null;
}

function linkifySources(content: string, agentId: string, wikiSubDir: string): string {
  const docMap = getDocLinkMap(agentId);
  if (docMap.size === 0) return content;
  const fromDir = `data/wiki/${getAgentFsName(agentId)}/${wikiSubDir}`;

  return content.replace(/\[来源:\s*([^\]]+)\](?!\()/g, (match, title) => {
    const trimmed = title.trim();
    const storedPath = docMap.get(trimmed);
    if (!storedPath) return match;
    const rel = path.relative(fromDir, storedPath + '/parsed.md').split(path.sep).join('/');
    return `[来源: ${trimmed}](${rel})`;
  });
}

// ---------------------------------------------------------------------------
// Index & log
// ---------------------------------------------------------------------------

export function loadIndex(agentId: string): string {
  const indexPath = path.join(getWikiDir(agentId), 'index.md');
  if (fs.existsSync(indexPath)) return fs.readFileSync(indexPath, 'utf-8');
  return '';
}

function parsePage(content: string): { title: string; related: string[]; sections: Map<string, string> } {
  const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
  const relatedMatch = content.match(/^related:\s*(.+)$/m);
  let related: string[] = [];
  if (relatedMatch) {
    const raw = relatedMatch[1].trim();
    if (raw.startsWith('[')) {
      try { related = JSON.parse(raw) as string[]; } catch { /* */ }
    } else {
      related = raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
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
    headers.push({ label: match[1].trim().replace(/\[\[([^\]]+)\]\]/g, '$1'), headerStart: match.index, contentStart: match.index + match[0].length });
  }
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].contentStart;
    const end = i + 1 < headers.length ? headers[i + 1].headerStart : mentionsBlock.length;
    sections.set(headers[i].label, mentionsBlock.slice(start, end).trim());
  }

  return { title: titleMatch?.[1] || 'untitled', related, sections };
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

function renderRelatedSection(related: string[]): string {
  if (related.length === 0) return '';
  return '## 关联\n\n' + related.map(r => `- [[${r}]]`).join('\n');
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
// writeWikiPage (used by file_to_wiki tool)
// ---------------------------------------------------------------------------

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

    const rawBody = content.includes('## 文档提及') ? content : `## 文档提及\n\n${content}\n\n${renderRelatedSection(related)}`;
    const body = linkifySources(rawBody, agentId, catDir);
    fs.writeFileSync(filePath, frontmatter + body, 'utf-8');
    writeIndex(wikiDir, rebuildIndex(wikiDir));
    appendLog(wikiDir, `query | ${title}`);
    return { success: true, path: `${catDir}/${slug}.md` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// relinkAllWikiPages (used by /relink-wiki CLI command)
// ---------------------------------------------------------------------------

export function relinkAllWikiPages(agentId: string): number {
  const wikiDir = getWikiDir(agentId);
  let updated = 0;
  for (const sub of ['entities', 'concepts', 'summaries', 'insights']) {
    const catDir = path.join(wikiDir, sub);
    if (!fs.existsSync(catDir)) continue;
    for (const file of fs.readdirSync(catDir).filter(f => f.endsWith('.md'))) {
      const filePath = path.join(catDir, file);
      const original = fs.readFileSync(filePath, 'utf-8');
      const linked = linkifySources(original, agentId, sub);
      if (linked !== original) {
        fs.writeFileSync(filePath, linked, 'utf-8');
        updated++;
      }
    }
  }
  return updated;
}
