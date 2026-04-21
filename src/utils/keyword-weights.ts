/**
 * Shared keyword weighting utilities for knowledge search.
 *
 * Both the DB FAQ search (weighted LIKE + CJK bigram) and the document grep
 * search consume this module so the two sides score broad/narrow terms with
 * consistent semantics.
 */

/**
 * Broad business terms that appear too frequently to carry specific signal.
 * Hits on these terms are down-weighted (to avoid blanket recall dominating
 * the ranking over narrower, more informative keywords).
 */
export const BROAD_BUSINESS_TERMS = new Set([
  '场外期权', '北向极速', '北向借券', '约券', '雪球', '借券',
]);

const CJK_RE = /^[\u4e00-\u9fff]+$/;

/**
 * Split long CJK keywords into overlapping bigrams so that SQLite LIKE can
 * match substrings without a dedicated tokenizer.
 *
 * For non-CJK terms (or short CJK terms of ≤2 chars) nothing is derived.
 */
export function expandCJKKeywords(
  rawKeywords: string[],
): { primary: string[]; derived: string[] } {
  const primary: string[] = [];
  const derived = new Set<string>();

  for (const kw of rawKeywords) {
    primary.push(kw);
    if (CJK_RE.test(kw) && kw.length > 2) {
      for (let i = 0; i + 2 <= kw.length; i += 2) {
        derived.add(kw.slice(i, i + 2));
      }
      for (let i = 1; i + 2 <= kw.length; i += 2) {
        derived.add(kw.slice(i, i + 2));
      }
    }
  }

  const primarySet = new Set(primary);
  return { primary, derived: [...derived].filter(d => !primarySet.has(d)) };
}

/**
 * Tier tags for a keyword:
 *   - 'normal': full weight (non-broad primary keyword).
 *   - 'broad':  broad business term → down-weighted.
 *   - 'derived': bigram derived from a longer CJK primary → further down-weighted.
 */
export type KeywordTier = 'normal' | 'broad' | 'derived';

/**
 * Classify each term (after CJK expansion) into a tier. Callers decide how
 * to translate tiers into concrete weights per field.
 */
export function classifyTerms(
  primary: string[],
  derived: string[],
): { term: string; tier: KeywordTier }[] {
  const out: { term: string; tier: KeywordTier }[] = [];
  for (const term of primary) {
    out.push({
      term,
      tier: BROAD_BUSINESS_TERMS.has(term) ? 'broad' : 'normal',
    });
  }
  for (const term of derived) {
    out.push({ term, tier: 'derived' });
  }
  return out;
}

/**
 * Multiplier applied on top of a field's base weight based on the term tier.
 *   - normal → 1.0 (full strength)
 *   - broad / derived → down-weighted; answer-like / body-like fields floor to 0
 */
export function tierMultiplier(tier: KeywordTier, field: 'primary' | 'body'): number {
  if (tier === 'normal') return 1;
  return field === 'primary' ? 1 : 0;
}
