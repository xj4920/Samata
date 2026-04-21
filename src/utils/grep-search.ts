import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCUMENTS_ROOT = path.resolve(__dirname, '../../data/documents');

export interface GrepSearchResult {
  source: 'document';
  document_id: string;
  title: string;
  agent_id: string;
  snippet: string;
  relevance: number;
  tags: string | null;
}

interface Frontmatter {
  document_id: string;
  agent_id: string;
  title: string;
  tags?: string;
  file_type?: string;
  created_by?: string;
  created_at?: string;
}

// --- Frontmatter parsing ----------------------------------------------------

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { frontmatter: {} as Frontmatter, body: content };

  const yaml = match[1];
  const fm: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
    fm[key] = val;
  }

  return {
    frontmatter: fm as unknown as Frontmatter,
    body: content.slice(match[0].length),
  };
}

// --- Ripgrep invocation -----------------------------------------------------

function rgAvailable(): boolean {
  try {
    execFileSync('rg', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

interface RgMatch {
  type: string;
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: { match: { text: string }; start: number; end: number }[];
  };
}

function runRipgrep(keywords: string[], agentId: string): RgMatch[] {
  const pattern = keywords.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const searchDir = path.join(DOCUMENTS_ROOT, agentId);
  if (!fs.existsSync(searchDir)) return [];

  const args = [
    '--json',
    '-C', '3',
    '--max-count', '50',
    '--',
    pattern,
    searchDir,
    // glob: only search parsed.md files
    '-g', 'parsed.md',
  ];

  try {
    const raw = execFileSync('rg', args, { maxBuffer: 10 * 1024 * 1024, timeout: 10000 });
    const lines = raw.toString().trim().split('\n').filter(Boolean);
    const matches: RgMatch[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'match') matches.push(obj);
      } catch { /* skip non-JSON lines */ }
    }
    return matches;
  } catch (e: any) {
    // rg returns exit code 1 when no matches — not an error
    if (e.status === 1) return [];
    log.warn(`ripgrep search failed: ${e.message}`);
    return [];
  }
}

// --- Fallback: Node.js file scan when rg is unavailable --------------------

function fallbackSearch(keywords: string[], agentId: string): { filePath: string; line_number: number; line: string; isHeading: boolean }[] {
  const agentDir = path.join(DOCUMENTS_ROOT, agentId);
  if (!fs.existsSync(agentDir)) return [];

  const hits: { filePath: string; line_number: number; line: string; isHeading: boolean }[] = [];
  const docDirs = fs.readdirSync(agentDir);

  for (const docDir of docDirs) {
    const mdPath = path.join(agentDir, docDir, 'parsed.md');
    if (!fs.existsSync(mdPath)) continue;

    const content = fs.readFileSync(mdPath, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matchCount = keywords.reduce((c, kw) => c + (line.includes(kw) ? 1 : 0), 0);
      if (matchCount > 0) {
        hits.push({ filePath: mdPath, line_number: i + 1, line, isHeading: /^#{1,4}\s/.test(line) });
      }
    }
  }
  return hits;
}

// --- Scoring & aggregation -------------------------------------------------

function scoreMatches(matches: RgMatch[], keywords: string[]): Map<string, { relevance: number; bestSnippet: string; frontmatter: Frontmatter }> {
  const fileScores = new Map<string, { relevance: number; bestSnippet: string; frontmatter: Frontmatter }>();

  for (const m of matches) {
    const filePath: string = m.data.path.text;
    const lineText: string = m.data.lines.text;
    const isHeading = /^#{1,4}\s/.test(lineText.trimStart());

    const matchCount = keywords.reduce((c, kw) => c + (lineText.includes(kw) ? 1 : 0), 0);
    const lineScore = matchCount * (isHeading ? 2 : 1);

    let entry = fileScores.get(filePath);
    if (!entry) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter } = parseFrontmatter(content);
      entry = { relevance: 0, bestSnippet: '', frontmatter };
      fileScores.set(filePath, entry);
    }

    entry.relevance += lineScore;

    // Keep the highest-scoring snippet (prefer heading matches)
    if (lineScore > 0 && (!entry.bestSnippet || (isHeading && entry.bestSnippet && !/^#{1,4}\s/.test(entry.bestSnippet)))) {
      // rg -C 3 already provides context, use the full matched block
      const snippet = lineText.trim();
      if (snippet.length <= 500) {
        entry.bestSnippet = snippet;
      } else {
        entry.bestSnippet = snippet.slice(0, 500) + '...';
      }
    }
  }

  return fileScores;
}

// --- Public API -------------------------------------------------------------

/**
 * Search document parsed.md files using ripgrep (or Node.js fallback).
 * Returns results sorted by relevance descending, limited to top N.
 */
export function grepSearchDocuments(keyword: string, agentId: string, limit = 10): GrepSearchResult[] {
  const keywords = keyword.split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return [];

  if (rgAvailable()) {
    const matches = runRipgrep(keywords, agentId);
    const fileScores = scoreMatches(matches, keywords);

    const results: GrepSearchResult[] = [];
    for (const [filePath, { relevance, bestSnippet, frontmatter }] of fileScores) {
      if (!frontmatter.document_id || !frontmatter.title) {
        // Fallback: derive from file path
        const docDir = path.basename(path.dirname(filePath));
        frontmatter.document_id = docDir;
        frontmatter.title = docDir;
      }
      results.push({
        source: 'document',
        document_id: frontmatter.document_id,
        title: frontmatter.title,
        agent_id: frontmatter.agent_id || agentId,
        snippet: bestSnippet,
        relevance,
        tags: frontmatter.tags || null,
      });
    }

    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit);
  }

  // Fallback: Node.js file scan
  const hits = fallbackSearch(keywords, agentId);
  const fileScores = new Map<string, { relevance: number; snippets: string[]; frontmatter: Frontmatter }>();

  for (const hit of hits) {
    let entry = fileScores.get(hit.filePath);
    if (!entry) {
      const content = fs.readFileSync(hit.filePath, 'utf-8');
      const { frontmatter } = parseFrontmatter(content);
      entry = { relevance: 0, snippets: [], frontmatter };
      fileScores.set(hit.filePath, entry);
    }

    entry.relevance += hit.isHeading ? 2 : 1;
    if (entry.snippets.length < 3) {
      const snippet = hit.line.trim();
      entry.snippets.push(snippet.length <= 500 ? snippet : snippet.slice(0, 500) + '...');
    }
  }

  const results: GrepSearchResult[] = [];
  for (const [filePath, { relevance, snippets, frontmatter }] of fileScores) {
    if (!frontmatter.document_id) {
      frontmatter.document_id = path.basename(path.dirname(filePath));
    }
    if (!frontmatter.title) {
      frontmatter.title = path.basename(path.dirname(filePath));
    }
    results.push({
      source: 'document',
      document_id: frontmatter.document_id,
      title: frontmatter.title,
      agent_id: frontmatter.agent_id || agentId,
      snippet: snippets.join('\n'),
      relevance,
      tags: frontmatter.tags || null,
    });
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, limit);
}