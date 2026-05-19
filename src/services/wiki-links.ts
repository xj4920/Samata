/**
 * Dynamic link discovery: persist cross-entity associations found during search.
 */
import fs from 'fs';
import path from 'path';
import { getWikiDir } from './wiki-compile.js';
import { log } from '../utils/logger.js';

const COOCCUR_FILE = '.link-cooccurrence.json';
const MIN_COOCCUR = parseInt(process.env.WIKI_LINK_MIN_COOCCUR || '2', 10);

interface CooccurStore {
  /** "A|B" (sorted) -> count */
  pairs: Record<string, number>;
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

function loadCooccur(wikiDir: string): CooccurStore {
  const p = path.join(wikiDir, COOCCUR_FILE);
  if (!fs.existsSync(p)) return { pairs: {} };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as CooccurStore;
  } catch {
    return { pairs: {} };
  }
}

function saveCooccur(wikiDir: string, store: CooccurStore): void {
  fs.writeFileSync(path.join(wikiDir, COOCCUR_FILE), JSON.stringify(store, null, 2), 'utf-8');
}

function parseFrontmatterRelated(content: string): string[] {
  const m = content.match(/^related:\s*(.+)$/m);
  if (!m) return [];
  const raw = m[1].trim();
  if (raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as string[];
    } catch { /* fall through */ }
  }
  return raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function parseFrontmatterTitle(content: string): string {
  const m = content.match(/^title:\s*"?(.+?)"?\s*$/m);
  return m?.[1] || '';
}

/** Append `name` to page's related frontmatter if not already present. */
function appendRelated(wikiDir: string, category: 'entities' | 'concepts', slug: string, name: string): boolean {
  const filePath = path.join(wikiDir, category, `${slug}.md`);
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, 'utf-8');
  const title = parseFrontmatterTitle(content);
  if (!title || title === name) return false;

  const existing = parseFrontmatterRelated(content);
  if (existing.some(r => r.toLowerCase() === name.toLowerCase())) return false;

  const updated = [...existing, name];
  if (content.match(/^related:\s*.+$/m)) {
    content = content.replace(/^related:\s*.+$/m, `related: ${JSON.stringify(updated)}`);
  } else {
    content = content.replace(/^---\n/, `---\nrelated: ${JSON.stringify(updated)}\n`);
  }

  // Rebuild ## 关联 section
  const bodyStart = content.indexOf('\n---\n');
  if (bodyStart === -1) return false;
  const fm = content.slice(0, bodyStart + 5);
  let body = content.slice(bodyStart + 5);

  const relatedSection = renderRelatedSection(updated);
  if (body.includes('## 关联')) {
    body = body.replace(/## 关联[\s\S]*?(?=\n## |\n### |$)/, relatedSection + '\n');
  } else {
    body = body.trimEnd() + '\n\n' + relatedSection + '\n';
  }

  fs.writeFileSync(filePath, fm + body, 'utf-8');
  return true;
}

function renderRelatedSection(related: string[]): string {
  if (related.length === 0) return '## 关联\n\n(暂无)';
  return '## 关联\n\n' + related.map(r => `- [[${r}]]`).join('\n');
}

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled';
}

function findPageSlug(wikiDir: string, name: string): { category: 'entities' | 'concepts'; slug: string } | null {
  for (const category of ['entities', 'concepts'] as const) {
    const catDir = path.join(wikiDir, category);
    if (!fs.existsSync(catDir)) continue;
    for (const file of fs.readdirSync(catDir).filter(f => f.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(catDir, file), 'utf-8');
      const title = parseFrontmatterTitle(content);
      if (title.toLowerCase() === name.toLowerCase()) {
        return { category, slug: file.replace(/\.md$/, '') };
      }
    }
  }
  return null;
}

export interface DiscoverableHit {
  title: string;
  category?: string;
}

/**
 * Fire-and-forget: when search hits multiple wiki entities/concepts,
 * record co-occurrence and persist links after threshold.
 */
export function discoverLinks(
  agentId: string,
  keyword: string,
  hits: DiscoverableHit[],
): void {
  if (!agentId || hits.length < 2) return;

  const wikiDir = getWikiDir(agentId);
  if (!fs.existsSync(wikiDir)) return;

  const names = [...new Set(
    hits
      .filter(h => h.category === 'entities' || h.category === 'entity' || h.category === 'concepts' || h.category === 'concept')
      .map(h => h.title.trim())
      .filter(Boolean),
  )];

  if (names.length < 2) return;

  const store = loadCooccur(wikiDir);
  const toLink: Array<[string, string]> = [];

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const key = pairKey(names[i], names[j]);
      store.pairs[key] = (store.pairs[key] || 0) + 1;
      if (store.pairs[key] >= MIN_COOCCUR) {
        toLink.push([names[i], names[j]]);
      }
    }
  }

  saveCooccur(wikiDir, store);

  for (const [a, b] of toLink) {
    const locA = findPageSlug(wikiDir, a);
    const locB = findPageSlug(wikiDir, b);
    if (locA) appendRelated(wikiDir, locA.category, locA.slug, b);
    if (locB) appendRelated(wikiDir, locB.category, locB.slug, a);
  }

  if (toLink.length > 0) {
    log.info(`[wiki-links] discoverLinks("${keyword}"): linked ${toLink.length} pair(s)`);
  }
}
