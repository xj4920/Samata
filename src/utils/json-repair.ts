/**
 * LLM JSON 输出修复工具
 *
 * LLM 输出的 JSON 常见问题：
 * 1. 字符串值中的裸换行符（应为 \\n）
 * 2. 字符串值中未转义的双引号（应为 \\"）
 * 3. 末尾多余逗号
 * 4. 输出被 max_tokens 截断导致 JSON 不完整
 * 5. 被 markdown 代码块或 <think> 标签包裹
 */

/**
 * 从 LLM 原始响应中解析 JSON 数组
 * 统一处理：去除包裹 → 修复非法字符 → 解析 → 截断修复
 *
 * @returns 解析后的数组，失败时 throw
 */
export function parseLLMJsonArray<T = unknown>(raw: string): T[] {
  let text = stripLLMWrapper(raw);

  // 定位顶层 JSON 数组起始
  const firstBracket = text.indexOf('[');
  if (firstBracket < 0) throw new Error('未找到 JSON 数组');
  if (firstBracket > 0) text = text.substring(firstBracket);

  // 修复字符串值中的非法字符（裸换行、未转义引号）
  text = fixJsonStringValues(text);

  // 修复常见格式错误
  text = text
    .replace(/,\s*]/g, ']')
    .replace(/,\s*}/g, '}')
    .trim();

  if (text === '[]') return [];

  // 尝试直接解析
  try {
    return JSON.parse(text);
  } catch {
    // 尝试修复截断
    const repaired = repairTruncatedJsonArray(text);
    if (repaired) {
      return JSON.parse(repaired);
    }
    throw new Error('JSON 解析失败且无法修复');
  }
}

/**
 * 从 LLM 原始响应中解析 JSON 对象
 * 适用于返回单个 {...} 的场景（如质量评分）
 */
export function parseLLMJsonObject<T = unknown>(raw: string): T {
  let text = stripLLMWrapper(raw);

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0) {
    throw new Error('未找到 JSON 对象');
  }
  text = lastBrace > firstBrace
    ? text.substring(firstBrace, lastBrace + 1)
    : text.substring(firstBrace);

  text = fixJsonStringValues(text)
    .replace(/,\s*]/g, ']')
    .replace(/,\s*}/g, '}')
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    const repaired = repairTruncatedJsonObject(text);
    if (repaired) return JSON.parse(repaired);
    throw new Error('JSON 对象解析失败且无法修复');
  }
}

/**
 * 去除 LLM 响应中的常见包裹：<think> 标签、markdown 代码块
 */
function stripLLMWrapper(raw: string): string {
  let text = raw.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  return text;
}

/**
 * 修复 JSON 字符串值中的非法字符
 *
 * 处理：
 * - 裸换行符 → \\n
 * - 裸制表符 → \\t
 * - 其他控制字符 (< 0x20) → \\n
 * - 未转义的双引号 → \\"（通过 lookahead 判断是否为闭合引号）
 */
function fixJsonStringValues(text: string): string {
  try { JSON.parse(text); return text; } catch {}

  let result = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '"') {
      result += text[i];
      i++;
      continue;
    }

    // 进入字符串
    result += text[i];
    i++;

    while (i < text.length) {
      const c = text[i];

      if (c === '\\') {
        result += c;
        i++;
        if (i < text.length) { result += text[i]; i++; }
        continue;
      }

      if (c === '"') {
        if (isClosingQuote(text, i + 1)) {
          result += c;
          i++;
          break;
        }
        result += '\\"';
        i++;
        continue;
      }

      if (c.charCodeAt(0) < 0x20) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        result += c === '\t' ? '\\t' : '\\n';
        i++;
        continue;
      }

      result += c;
      i++;
    }
  }

  return result;
}

/**
 * 判断引号后是否为 JSON 结构字符（即该引号是否为字符串闭合引号）
 */
function isClosingQuote(text: string, pos: number): boolean {
  let j = pos;
  while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
  if (j >= text.length) return true;
  return ',}]:'.includes(text[j]);
}

/**
 * 修复被截断的 JSON 数组，保留最后一个完整的顶层对象
 */
function repairTruncatedJsonArray(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let lastCompleteObjectEnd = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\' && inString) { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;

    if (depth === 1 && ch === '}') {
      lastCompleteObjectEnd = i;
    }
  }

  if (lastCompleteObjectEnd <= 0) return null;
  return (trimmed.substring(0, lastCompleteObjectEnd + 1) + ']').replace(/,\s*]$/, ']');
}

function repairTruncatedJsonObject(text: string): string | null {
  const trimmed = text.trim().replace(/,\s*$/, '');
  if (!trimmed.startsWith('{')) return null;

  const stack: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\' && inString) { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') stack.push('}');
    if (ch === '[') stack.push(']');
    if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] !== ch) return null;
      stack.pop();
    }
  }

  const closed = `${trimmed}${inString ? '"' : ''}${stack.reverse().join('')}`
    .replace(/,\s*([}\]])/g, '$1');
  try {
    JSON.parse(closed);
    return closed;
  } catch {
    return null;
  }
}
