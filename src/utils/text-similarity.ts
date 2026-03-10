/**
 * 文本相似度工具函数
 * 字符 bigram Jaccard 相似度，适合中文文本（无需分词）
 */

/**
 * 标准化文本：小写、去空格、去标点
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（）()\[\]{}「」""''、，。？！：；·\-—《》<>\/\\|~`@#$%^&*+=]/g, '')
    .replace(/[,.?!:;'"]/g, '');
}

/**
 * 提取字符 bigram 集合（适合中文，无需分词）
 */
export function charBigrams(text: string): Set<string> {
  const n = normalize(text);
  const bigrams = new Set<string>();
  for (let i = 0; i < n.length - 1; i++) {
    bigrams.add(n.slice(i, i + 2));
  }
  return bigrams;
}

/**
 * Jaccard 相似度
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  let intersection = 0;
  for (const g of a) {
    if (b.has(g)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 按 bigram Jaccard 相似度对文本列表排序，使相似项相邻
 * 贪心策略：每次选与当前最相似的未访问项
 */
export function sortBySimilarity<T>(items: T[], getText: (item: T) => string): { sorted: T[]; originalIndices: number[] } {
  if (items.length <= 1) {
    return { sorted: [...items], originalIndices: items.map((_, i) => i) };
  }

  const bigrams = items.map(item => charBigrams(getText(item)));
  const visited = new Set<number>();
  const order: number[] = [];

  let current = 0;
  visited.add(current);
  order.push(current);

  while (order.length < items.length) {
    let bestIdx = -1;
    let bestSim = -1;

    for (let i = 0; i < items.length; i++) {
      if (visited.has(i)) continue;
      const sim = jaccardSimilarity(bigrams[current], bigrams[i]);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    visited.add(bestIdx);
    order.push(bestIdx);
    current = bestIdx;
  }

  return {
    sorted: order.map(i => items[i]),
    originalIndices: order,
  };
}
