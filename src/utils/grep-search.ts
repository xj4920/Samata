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
  document_id?: string;
  agent_id?: string;
  title?: string;
  tags?: string;
  file_type?: string;
  created_by?: string;
  created_at?: string;
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

interface RgRecord {
  type: 'match' | 'context' | string;
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches?: { match: { text: string }; start: number; end: number }[];
  };
}

/**
 * Invoke ripgrep with the ordered list of terms. Returns raw per-line records
 * (both matches and context rows). Never throws on "no match" (exit code 1).
 */
function runRipgrep(terms: string[], agentId: string): RgRecord[] {
  const searchDir = path.join(DOCUMENTS_ROOT, getAgentFsName(agentId));
  if (!fs.existsSync(searchDir)) return [];

  const args: string[] = [
    '-F',
    '-i',
    '--json',
    '-C', '3',
    '--max-count', '50',
    '--glob', '**/parsed.md',
  ];
  for (const t of terms) {
    args.push('-e', t);
  }
  args.push('--', searchDir);

  try {
    const raw = execFileSync('rg', args, { maxBuffer: 10 * 1024 * 1024, timeout: 10000 });
    const lines = raw.toString().trim().split('\n').filter(Boolean);
    const records: RgRecord[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'match' || obj.type === 'context') records.push(obj);
      } catch { /* skip non-JSON */ }
    }
    return records;
  } catch (e: any) {
    if (e.status === 1) return [];
    log.warn(`ripgrep search failed: ${e.message}`);
    return [];
  }
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

function readFileState(filePath: string): Pick<FileState, 'frontmatter' | 'fmRange'> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, range } = parseFrontmatter(content);
    return { frontmatter, fmRange: range };
  } catch {
    return { frontmatter: {}, fmRange: null };
  }
}

function assembleRecords(records: RgRecord[]): Map<string, FileState> {
  const states = new Map<string, FileState>();

  for (const rec of records) {
    const filePath = rec.data.path.text;
    const lineNumber = rec.data.line_number;
    const lineText = rec.data.lines.text.replace(/\n$/, '');

    let state = states.get(filePath);
    if (!state) {
      const { frontmatter, fmRange } = readFileState(filePath);
      state = {
        filePath,
        lines: new Map(),
        matchLines: [],
        submatchesByLine: new Map(),
        frontmatter,
        fmRange,
      };
      states.set(filePath, state);
    }

    if (!state.lines.has(lineNumber)) {
      state.lines.set(lineNumber, lineText);
    }

    if (rec.type === 'match') {
      if (!state.submatchesByLine.has(lineNumber)) {
        state.matchLines.push(lineNumber);
        state.submatchesByLine.set(lineNumber, []);
      }
      const bucket = state.submatchesByLine.get(lineNumber)!;
      for (const sm of rec.data.submatches ?? []) {
        bucket.push(sm.match.text.toLowerCase());
      }
    }
  }

  return states;
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

  const results: ScoredFile[] = [];
  const docDirs = fs.readdirSync(agentDir);
  const termsLower = terms.map(t => t.toLowerCase());

  for (const docDir of docDirs) {
    const mdPath = path.join(agentDir, docDir, 'parsed.md');
    if (!fs.existsSync(mdPath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(mdPath, 'utf-8');
    } catch { continue; }

    const { frontmatter, range: fmRange } = parseFrontmatter(content);
    const lines = content.split('\n');

    // Build synthetic FileState for consistent scoring
    const state: FileState = {
      filePath: mdPath,
      lines: new Map(),
      matchLines: [],
      submatchesByLine: new Map(),
      frontmatter,
      fmRange,
    };

    for (let i = 0; i < lines.length; i++) {
      state.lines.set(i + 1, lines[i]);
      const lower = lines[i].toLowerCase();
      const hits: string[] = [];
      for (let t = 0; t < termsLower.length; t++) {
        if (lower.includes(termsLower[t])) hits.push(termsLower[t]);
      }
      if (hits.length > 0) {
        state.matchLines.push(i + 1);
        state.submatchesByLine.set(i + 1, hits);
      }
    }

    if (state.matchLines.length === 0) continue;

    const scored = scoreFile(state, termTiers);
    if (scored.relevance > 0) results.push(scored);
  }

  return results;
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
): GrepSearchResult[] {
  const rawKeywords = keyword.split(/\s+/).filter(Boolean);
  if (rawKeywords.length === 0) return [];

  const { primary, derived } = expandCJKKeywords(rawKeywords);
  const classified = classifyTerms(primary, derived);
  const terms = classified.map(c => c.term);
  const termTiers = new Map<string, KeywordTier>();
  for (const c of classified) termTiers.set(c.term.toLowerCase(), c.tier);

  let scored: ScoredFile[];
  if (rgAvailable()) {
    const records = runRipgrep(terms, agentId);
    const states = assembleRecords(records);
    scored = [...states.values()]
      .map(s => scoreFile(s, termTiers))
      .filter(s => s.relevance > 0);
  } else {
    scored = fallbackScan(terms, termTiers, agentId);
  }

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
    });
  }
  return results;
}
