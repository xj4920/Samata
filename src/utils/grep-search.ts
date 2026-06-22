import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
import { getAgentFsName } from '../commands/document-import.js';
import {
  expandCJKKeywords,
  classifyTerms,
  type KeywordTier,
} from './keyword-weights.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCUMENTS_ROOT = path.resolve(__dirname, '../../data/documents');
const WIKI_ROOT = path.resolve(__dirname, '../../data/wiki');
const RG_MAX_BUFFER_BYTES = Number(process.env.RG_MAX_BUFFER_BYTES || 40 * 1024 * 1024);
const RG_TIMEOUT_MS = Number(process.env.RG_TIMEOUT_MS || 15_000);
const RG_MAX_FILESIZE = process.env.RG_MAX_FILESIZE || '2M';

export interface GrepSearchResult {
  source: 'document';
  document_id: string;
  title: string;
  agent_id: string;
  snippet: string;
  relevance: number;
  tags: string | null;
  doc_date?: string | null;
}

interface Frontmatter {
  document_id?: string;
  agent_id?: string;
  title?: string;
  tags?: string;
  file_type?: string;
  created_by?: string;
  created_at?: string;
  doc_date?: string;
}

// --- Frontmatter parsing ----------------------------------------------------

/**
 * Parse YAML frontmatter at the top of a markdown file.
 * Also returns the inclusive line-number range (1-indexed) of the frontmatter
 * block (including the opening/closing `---` markers) so that grep hits inside
 * it can be classified and filtered.
 */
function parseFrontmatter(content: string): {
  frontmatter: Frontmatter;
  range: { start: number; end: number } | null;
} {
  const lines = content.split('\n');
  if (lines[0] !== '---') return { frontmatter: {}, range: null };

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { frontmatter: {}, range: null };

  const fm: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
    fm[key] = val;
  }

  return {
    frontmatter: fm as Frontmatter,
    range: { start: 1, end: endIdx + 1 },
  };
}

// --- Zone classification ----------------------------------------------------

type Zone = 'title' | 'tags' | 'heading' | 'body' | 'meta';

/**
 * Classify a single line into a scoring zone.
 *   - frontmatter title / tags  → score-worthy
 *   - other frontmatter keys (document_id / agent_id / created_at / created_by / file_type) → 'meta' (dropped)
 *   - markdown heading  `#..####`  → heading
 *   - all other lines  → body
 */
function classifyLine(
  lineText: string,
  lineNumber: number,
  fmRange: { start: number; end: number } | null,
): Zone {
  if (fmRange && lineNumber >= fmRange.start && lineNumber <= fmRange.end) {
    const m = lineText.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    if (!m) return 'meta';
    const key = m[1];
    if (key === 'title') return 'title';
    if (key === 'tags') return 'tags';
    return 'meta';
  }
  if (/^#{1,4}\s/.test(lineText.trimStart())) return 'heading';
  return 'body';
}

/**
 * Weight a match in a given zone for a keyword of a given tier.
 * Mirror of FAQ-side weighting:
 *   normal term:          title 3 / tags 2 / heading 2 / body 1 / meta 0
 *   broad or bigram term: title 1 / tags 1 / heading 1 / body 0 / meta 0
 */
function lineWeight(zone: Zone, tier: KeywordTier): number {
  if (zone === 'meta') return 0;
  if (tier === 'normal') {
    if (zone === 'title') return 3;
    if (zone === 'tags' || zone === 'heading') return 2;
    return 1; // body
  }
  // broad or derived
  if (zone === 'body') return 0;
  return 1;
}

// --- Ripgrep ----------------------------------------------------------------

function rgAvailable(): boolean {
  try {
    execFileSync('rg', ['--version'], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isInsideDir(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function buildRipgrepFileArgs(
  terms: string[],
  searchDir: string,
  glob: string,
): string[] {
  const args: string[] = [
    '-F',
    '-i',
    '--files-with-matches',
    '--max-filesize', RG_MAX_FILESIZE,
    '--glob', glob,
  ];
  for (const t of terms) {
    args.push('-e', t);
  }
  args.push('--', searchDir);
  return args;
}

function isRipgrepBufferOverflow(e: any): boolean {
  return e?.code === 'ENOBUFS' || String(e?.message || '').includes('ENOBUFS');
}

function execRipgrepFileList(
  args: string[],
  warnLabel: string,
  searchDir: string,
): string[] | null {
  try {
    const raw = execFileSync('rg', args, { maxBuffer: RG_MAX_BUFFER_BYTES, timeout: RG_TIMEOUT_MS });
    return raw.toString().split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(filePath => path.isAbsolute(filePath) ? filePath : path.resolve(searchDir, filePath))
      .filter(filePath => isInsideDir(searchDir, filePath));
  } catch (e: any) {
    if (e.status === 1) return [];
    if (isRipgrepBufferOverflow(e)) {
      log.warn(`${warnLabel}: candidate file list exceeded ${RG_MAX_BUFFER_BYTES} bytes, falling back to Node scan`);
      return null;
    }
    log.warn(`${warnLabel}: ${e.message}`);
    return null;
  }
}

/**
 * Use ripgrep only to identify candidate files. Matching and snippet assembly
 * happen inside Node so broad queries cannot overflow child-process stdout.
 */
function listRipgrepCandidateFiles(terms: string[], searchDir: string, glob: string, warnLabel: string): string[] | null {
  if (!fs.existsSync(searchDir)) return [];
  return execRipgrepFileList(buildRipgrepFileArgs(terms, searchDir, glob), warnLabel, searchDir);
}

// --- Per-file aggregation ---------------------------------------------------

interface FileState {
  /** Absolute path of the parsed.md file. */
  filePath: string;
  /** Line text indexed by 1-based line number (both match and context rows). */
  lines: Map<number, string>;
  /** 1-based line numbers of match rows (preserve insertion order). */
  matchLines: number[];
  /** Per-match-line submatch texts (lowercased), indexed by line number. */
  submatchesByLine: Map<number, string[]>;
  frontmatter: Frontmatter;
  fmRange: { start: number; end: number } | null;
}

function scanMarkdownFile(filePath: string, termsLower: string[]): FileState | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const { frontmatter, range: fmRange } = parseFrontmatter(content);
  const lines = content.split('\n');
  const state: FileState = {
    filePath,
    lines: new Map(),
    matchLines: [],
    submatchesByLine: new Map(),
    frontmatter,
    fmRange,
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    state.lines.set(lineNumber, lines[i]);
    const lower = lines[i].toLowerCase();
    const hits: string[] = [];
    for (const term of termsLower) {
      if (lower.includes(term)) hits.push(term);
    }
    if (hits.length > 0) {
      state.matchLines.push(lineNumber);
      state.submatchesByLine.set(lineNumber, hits);
    }
  }

  return state.matchLines.length > 0 ? state : null;
}

function scoreMarkdownFiles(
  filePaths: string[],
  terms: string[],
  termTiers: Map<string, KeywordTier>,
  options: { skipIndexAndLog?: boolean } = {},
): ScoredFile[] {
  const scored: ScoredFile[] = [];
  const termsLower = terms.map(t => t.toLowerCase());

  for (const filePath of filePaths) {
    if (options.skipIndexAndLog) {
      const name = path.basename(filePath);
      if (name === 'index.md' || name === 'log.md') continue;
    }

    const state = scanMarkdownFile(filePath, termsLower);
    if (!state) continue;

    const item = scoreFile(state, termTiers);
    if (item.relevance > 0) scored.push(item);
  }

  return scored;
}

function listDocumentMarkdownFiles(agentDir: string): string[] {
  const files: string[] = [];
  for (const docDir of fs.readdirSync(agentDir)) {
    const mdPath = path.join(agentDir, docDir, 'parsed.md');
    if (fs.existsSync(mdPath)) files.push(mdPath);
  }
  return files;
}

function listMarkdownFilesRecursive(searchDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.md') && entry.name !== 'index.md' && entry.name !== 'log.md') {
        files.push(fullPath);
      }
    }
  }

  walk(searchDir);
  return files;
}

// --- Scoring & snippet ------------------------------------------------------

const SNIPPET_MAX_LEN = 500;
const CONTEXT_RADIUS = 3;

function buildSnippet(state: FileState, lineNumber: number): string {
  const parts: string[] = [];
  for (let ln = lineNumber - CONTEXT_RADIUS; ln <= lineNumber + CONTEXT_RADIUS; ln++) {
    const text = state.lines.get(ln);
    if (text === undefined) continue;
    parts.push(text);
  }
  const joined = parts.join('\n').trim();
  if (joined.length <= SNIPPET_MAX_LEN) return joined;
  return joined.slice(0, SNIPPET_MAX_LEN) + '...';
}

interface ScoredFile {
  relevance: number;
  snippet: string;
  frontmatter: Frontmatter;
  filePath: string;
}

export interface DocumentSearchOptions {
  dateFrom?: string;
  dateTo?: string;
  includeUndated?: boolean;
}

function isIsoDate(value: string | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isDocumentDateAllowed(frontmatter: Frontmatter, options: DocumentSearchOptions): boolean {
  const hasDateFilter = !!options.dateFrom || !!options.dateTo;
  if (!hasDateFilter) return true;

  const docDate = frontmatter.doc_date;
  if (!isIsoDate(docDate)) return options.includeUndated === true;
  if (options.dateFrom && docDate < options.dateFrom) return false;
  if (options.dateTo && docDate > options.dateTo) return false;
  return true;
}

function scoreFile(
  state: FileState,
  termTiers: Map<string, KeywordTier>,
): ScoredFile {
  let relevance = 0;
  let bestLineScore = 0;
  let bestLine = -1;

  for (const ln of state.matchLines) {
    const lineText = state.lines.get(ln) ?? '';
    const zone = classifyLine(lineText, ln, state.fmRange);
    if (zone === 'meta') continue; // drop frontmatter non-whitelisted fields

    let lineScore = 0;
    const submatches = state.submatchesByLine.get(ln) ?? [];
    for (const sm of submatches) {
      const tier = termTiers.get(sm) ?? 'normal';
      lineScore += lineWeight(zone, tier);
    }
    if (lineScore === 0) continue;

    relevance += lineScore;
    if (lineScore > bestLineScore) {
      bestLineScore = lineScore;
      bestLine = ln;
    }
  }

  const snippet = bestLine > 0 ? buildSnippet(state, bestLine) : '';
  return {
    relevance,
    snippet,
    frontmatter: state.frontmatter,
    filePath: state.filePath,
  };
}

// --- Fallback (no ripgrep) --------------------------------------------------

function fallbackScan(
  terms: string[],
  termTiers: Map<string, KeywordTier>,
  agentId: string,
): ScoredFile[] {
  const agentDir = path.join(DOCUMENTS_ROOT, getAgentFsName(agentId));
  if (!fs.existsSync(agentDir)) return [];

  return scoreMarkdownFiles(listDocumentMarkdownFiles(agentDir), terms, termTiers);
}

// --- Public API -------------------------------------------------------------

/**
 * Search document parsed.md files using ripgrep (falls back to Node.js scan).
 * Returns results sorted by relevance desc, capped at `limit`.
 *
 * Scoring:
 *   - frontmatter title hit = 3, tags hit = 2, other fm keys = dropped
 *   - markdown heading hit = 2, body hit = 1
 *   - broad business terms or bigram-derived terms floor to 1 (body = 0)
 *   - snippet = best-scoring match line + ±3 context lines, trimmed to 500 chars
 */
export function grepSearchDocuments(
  keyword: string,
  agentId: string,
  limit = 5,
  options: DocumentSearchOptions = {},
): GrepSearchResult[] {
  const rawKeywords = keyword.split(/\s+/).filter(Boolean);
  if (rawKeywords.length === 0) return [];

  const { primary, derived } = expandCJKKeywords(rawKeywords);
  const classified = classifyTerms(primary, derived);
  const terms = classified.map(c => c.term);
  const termTiers = new Map<string, KeywordTier>();
  for (const c of classified) termTiers.set(c.term.toLowerCase(), c.tier);

  let scored: ScoredFile[];
  const searchDir = path.join(DOCUMENTS_ROOT, getAgentFsName(agentId));
  if (rgAvailable()) {
    const files = listRipgrepCandidateFiles(terms, searchDir, '**/parsed.md', 'ripgrep search failed');
    scored = files === null ? fallbackScan(terms, termTiers, agentId) : scoreMarkdownFiles(files, terms, termTiers);
  } else {
    scored = fallbackScan(terms, termTiers, agentId);
  }

  scored = scored.filter(s => isDocumentDateAllowed(s.frontmatter, options));
  scored.sort((a, b) => b.relevance - a.relevance);

  const results: GrepSearchResult[] = [];
  for (const s of scored.slice(0, limit)) {
    const docDir = path.basename(path.dirname(s.filePath));
    results.push({
      source: 'document',
      document_id: s.frontmatter.document_id || docDir,
      title: s.frontmatter.title || docDir,
      agent_id: s.frontmatter.agent_id || agentId,
      snippet: s.snippet,
      relevance: s.relevance,
      tags: s.frontmatter.tags || null,
      doc_date: s.frontmatter.doc_date || null,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Wiki search (same scoring as documents, searches data/wiki/<agent>/)
// ---------------------------------------------------------------------------

export interface WikiSearchResult {
  source: 'wiki';
  page_path: string;
  title: string;
  category: string;
  snippet: string;
  relevance: number;
  /** true when matched by title/related exact lookup (Phase 4) */
  exact_match?: boolean;
}

function parseWikiFrontmatter(content: string): { title: string; related: string[]; category: string } {
  const title = content.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1] || '';
  const category = content.match(/^category:\s*(\w+)\s*$/m)?.[1] || '';
  const relRaw = content.match(/^related:\s*(.+)$/m)?.[1];
  let related: string[] = [];
  if (relRaw) {
    const t = relRaw.trim();
    if (t.startsWith('[')) {
      try { related = JSON.parse(t); } catch { related = t.split(',').map(s => s.trim()); }
    } else {
      related = t.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    }
  }
  return { title, related, category };
}

/**
 * Phase 4: exact match on entity/concept page title or related list before full-text grep.
 */
export function searchWikiEntitiesExact(
  keyword: string,
  agentId: string,
  limit = 5,
): WikiSearchResult[] {
  const rawKeywords = keyword.split(/\s+/).filter(Boolean);
  if (rawKeywords.length === 0) return [];

  const searchDir = path.join(WIKI_ROOT, getAgentFsName(agentId));
  if (!fs.existsSync(searchDir)) return [];

  const termsLower = rawKeywords.map(t => t.toLowerCase());
  const results: WikiSearchResult[] = [];

  for (const category of ['entities', 'concepts'] as const) {
    const catDir = path.join(searchDir, category);
    if (!fs.existsSync(catDir)) continue;

    for (const file of fs.readdirSync(catDir).filter(f => f.endsWith('.md'))) {
      const filePath = path.join(catDir, file);
      let content: string;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

      const { title, related } = parseWikiFrontmatter(content);
      const titleLower = title.toLowerCase();
      const haystack = [titleLower, ...related.map(r => r.toLowerCase())];

      let score = 0;
      for (const term of termsLower) {
        if (haystack.some(h => h === term || h.includes(term))) score += 10;
        else if (titleLower.includes(term)) score += 5;
      }
      if (score === 0) continue;

      const bodyStart = content.indexOf('\n---\n');
      const body = bodyStart >= 0 ? content.slice(bodyStart + 5) : content;
      const snippet = body.replace(/^#+\s+/gm, '').slice(0, 500);

      results.push({
        source: 'wiki',
        page_path: `${category}/${file}`,
        title,
        category,
        snippet,
        relevance: score + 100,
        exact_match: true,
      });
    }
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, limit);
}

function fallbackScanDir(
  terms: string[],
  termTiers: Map<string, KeywordTier>,
  searchDir: string,
): ScoredFile[] {
  if (!fs.existsSync(searchDir)) return [];
  return scoreMarkdownFiles(listMarkdownFilesRecursive(searchDir), terms, termTiers);
}

/**
 * Search wiki pages for a given agent. Same scoring as document search
 * but searches data/wiki/<agent>/ directory (excluding index.md and log.md).
 */
export function grepSearchWiki(
  keyword: string,
  agentId: string,
  limit = 5,
): WikiSearchResult[] {
  const rawKeywords = keyword.split(/\s+/).filter(Boolean);
  if (rawKeywords.length === 0) return [];

  const searchDir = path.join(WIKI_ROOT, getAgentFsName(agentId));
  if (!fs.existsSync(searchDir)) return [];

  const { primary, derived } = expandCJKKeywords(rawKeywords);
  const classified = classifyTerms(primary, derived);
  const terms = classified.map(c => c.term);
  const termTiers = new Map<string, KeywordTier>();
  for (const c of classified) termTiers.set(c.term.toLowerCase(), c.tier);

  let scored: ScoredFile[];
  if (rgAvailable()) {
    const files = listRipgrepCandidateFiles(terms, searchDir, '**/*.md', 'ripgrep wiki search failed');
    scored = files === null
      ? fallbackScanDir(terms, termTiers, searchDir)
      : scoreMarkdownFiles(files, terms, termTiers, { skipIndexAndLog: true });
  } else {
    scored = fallbackScanDir(terms, termTiers, searchDir);
  }

  scored.sort((a, b) => b.relevance - a.relevance);

  const results: WikiSearchResult[] = [];
  for (const s of scored.slice(0, limit)) {
    const relPath = path.relative(searchDir, s.filePath);
    // Skip index and log
    if (relPath === 'index.md' || relPath === 'log.md') continue;

    const category = path.dirname(relPath).split(path.sep)[0] || 'unknown';
    results.push({
      source: 'wiki',
      page_path: relPath,
      title: s.frontmatter.title || path.basename(s.filePath, '.md'),
      category,
      snippet: s.snippet,
      relevance: s.relevance,
    });
  }
  return results;
}
