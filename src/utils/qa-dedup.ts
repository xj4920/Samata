/**
 * QA 语义去重模块
 * 两层过滤：Layer 1 字符 bigram Jaccard（无 LLM 开销） → Layer 2 LLM 语义判定（仅对 top-N 候选）
 */
import type Database from 'better-sqlite3';
import { getProviderForTask, getModelForTask } from '../llm/provider.js';

export interface DedupCandidate {
  id: string;
  question: string;
  answer: string;
  similarity: number;
  semanticMatch?: boolean;
  confidence?: number;
}

export interface DedupResult {
  hasDuplicate: boolean;
  candidates: DedupCandidate[];
  layerReached: 1 | 2;
}

export interface DedupOptions {
  topN?: number;
  layer1Threshold?: number;
  skipLLM?: boolean;
}

const DEFAULTS = {
  topN: 5,
  layer1Threshold: 0.25,
  highSimilarityThreshold: 0.85,
  layer1OnlyThreshold: 0.5,
  llmConfidenceThreshold: 0.7,
};

// ============ Layer 1: 字符 bigram Jaccard ============

/**
 * 标准化文本：小写、去空格、去标点
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（）()\[\]{}「」""''、，。？！：；·\-—《》<>\/\\|~`@#$%^&*+=]/g, '')
    .replace(/[,.?!:;'"]/g, '');
}

/**
 * 提取字符 bigram 集合（适合中文，无需分词）
 */
function charBigrams(text: string): Set<string> {
  const n = normalize(text);
  const bigrams = new Set<string>();
  for (let i = 0; i < n.length - 1; i++) {
    bigrams.add(n.slice(i, i + 2));
  }
  return bigrams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  let intersection = 0;
  for (const g of a) {
    if (b.has(g)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface KnowledgeRow {
  id: string;
  question: string;
  answer: string;
}

function layer1Filter(
  newQuestion: string,
  existing: KnowledgeRow[],
  threshold: number,
  topN: number
): DedupCandidate[] {
  const newBigrams = charBigrams(newQuestion);

  const scored = existing.map(row => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    similarity: jaccardSimilarity(newBigrams, charBigrams(row.question)),
  }));

  return scored
    .filter(s => s.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topN);
}

// ============ Layer 2: LLM 语义判定 ============

function extractJsonArray(raw: string): string | null {
  let text = raw.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();

  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first === -1 || last === -1 || last <= first) return null;
  text = text.substring(first, last + 1);

  text = text.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}').trim();

  let brackets = 0;
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }
  if (brackets !== 0) return null;

  return text;
}

async function layer2LLMCheck(
  newQuestion: string,
  candidates: DedupCandidate[]
): Promise<DedupCandidate[]> {
  const candidateList = candidates
    .map((c, i) => `[${i + 1}] ${c.question}`)
    .join('\n');

  const prompt = `判断以下新问题是否与已有问题语义重复。

新问题：${newQuestion}

已有问题：
${candidateList}

判定标准：
- "重复"：核心问题相同，只是表述方式不同，答案会高度重叠
- "不重复"：虽涉及相同领域，但问的是不同方面、不同深度或不同场景

返回 JSON 数组，每个元素：
{"index": 编号, "duplicate": true/false, "confidence": 0.0-1.0}

只返回 JSON。`;

  const provider = getProviderForTask('classification');
  const model = getModelForTask('classification');

  const response = await provider.createMessage({
    model,
    max_tokens: 500,
    system: '你是知识库去重专家。直接返回 JSON 结果。',
    tools: [],
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return candidates;

  const jsonText = extractJsonArray(textBlock.text);
  if (!jsonText) return candidates;

  try {
    const results = JSON.parse(jsonText) as Array<{ index: number; duplicate: boolean; confidence: number }>;
    for (const r of results) {
      const idx = r.index - 1; // 1-based → 0-based
      if (idx >= 0 && idx < candidates.length) {
        candidates[idx].semanticMatch = r.duplicate;
        candidates[idx].confidence = r.confidence;
      }
    }
  } catch {
    // JSON 解析失败，保持 candidates 原样（semanticMatch 为 undefined）
  }

  return candidates;
}

// ============ 主入口 ============

export async function findSimilarQuestions(
  db: Database.Database,
  newQuestion: string,
  options?: DedupOptions
): Promise<DedupResult> {
  const topN = options?.topN ?? DEFAULTS.topN;
  const threshold = options?.layer1Threshold ?? DEFAULTS.layer1Threshold;
  const skipLLM = options?.skipLLM ?? (process.env.DEDUP_SKIP_LLM === 'true');

  // 加载所有已有问题
  const existing = db.prepare(
    'SELECT id, question, answer FROM knowledge'
  ).all() as KnowledgeRow[];

  if (existing.length === 0) {
    return { hasDuplicate: false, candidates: [], layerReached: 1 };
  }

  // 精确匹配快速路径
  const exact = existing.find(r => r.question.trim() === newQuestion.trim());
  if (exact) {
    return {
      hasDuplicate: true,
      candidates: [{ id: exact.id, question: exact.question, answer: exact.answer, similarity: 1.0, semanticMatch: true, confidence: 1.0 }],
      layerReached: 1,
    };
  }

  // Layer 1
  const candidates = layer1Filter(newQuestion, existing, threshold, topN);

  if (candidates.length === 0) {
    return { hasDuplicate: false, candidates: [], layerReached: 1 };
  }

  // 字符串高度相似，直接判定重复
  if (candidates[0].similarity >= DEFAULTS.highSimilarityThreshold) {
    candidates[0].semanticMatch = true;
    candidates[0].confidence = 1.0;
    return { hasDuplicate: true, candidates, layerReached: 1 };
  }

  // 跳过 LLM 模式
  if (skipLLM) {
    const hasDup = candidates[0].similarity >= DEFAULTS.layer1OnlyThreshold;
    return { hasDuplicate: hasDup, candidates, layerReached: 1 };
  }

  // Layer 2: LLM 语义判定
  try {
    await layer2LLMCheck(newQuestion, candidates);
  } catch (err: any) {
    // LLM 不可用，降级为 Layer 1
    console.warn(`  去重 LLM 不可用（${err.message}），仅使用字符串匹配`);
    const hasDup = candidates[0].similarity >= DEFAULTS.layer1OnlyThreshold;
    return { hasDuplicate: hasDup, candidates, layerReached: 1 };
  }

  const confirmed = candidates.filter(
    c => c.semanticMatch === true && (c.confidence ?? 0) >= DEFAULTS.llmConfidenceThreshold
  );

  return {
    hasDuplicate: confirmed.length > 0,
    candidates,
    layerReached: 2,
  };
}
