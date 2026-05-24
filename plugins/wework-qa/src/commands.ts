import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function getDumpDir(): string {
  return process.env.WEWORK_DUMP_DIR || `${process.env.HOME}/Documents/my/XBase/dump/wework`;
}

// ─── Message types ───────────────────────────────────────────────────────────

export interface WeworkMessage {
  time: string;
  session: string;
  sender: string;
  content: string;
}

export interface QAPair {
  question: string;
  answer: string;
  tags?: string[];
  time: string;
  session: string;
  questioner: string;
  answerer: string;
  context?: string;
}

// ─── Wework message reader ──────────────────────────────────────────────────

const MSG_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]: (.+?): ([\s\S]+)$/;

function parseMsgLine(line: string): { time: string; sender: string; content: string } | null {
  const m = MSG_RE.exec(line);
  if (!m) return null;
  return { time: m[1], sender: m[2], content: m[3] };
}

export async function fetchWeworkMessages(params: {
  session?: string;
  sender?: string;
  keyword?: string;
  limit?: number;
  contextLines?: number;
}): Promise<WeworkMessage[]> {
  const limit = params.limit ?? 100;
  const contextLines = params.contextLines ?? 0;
  const dumpDir = getDumpDir();
  const entries = readdirSync(dumpDir, { withFileTypes: true });

  const sessionDirs: { name: string; path: string }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (params.session && !e.name.toLowerCase().includes(params.session.toLowerCase())) continue;
    sessionDirs.push({ name: e.name, path: join(dumpDir, e.name) });
  }

  const messages: WeworkMessage[] = [];

  for (const dir of sessionDirs) {
    const files = readdirSync(dir.path)
      .filter(f => f.endsWith('.txt'))
      .sort()
      .reverse();

    for (const file of files) {
      const lines = readFileSync(join(dir.path, file), 'utf-8').split('\n');

      if (params.keyword && contextLines > 0) {
        const allParsed: { time: string; sender: string; content: string }[] = [];
        for (const line of lines) {
          const parsed = parseMsgLine(line);
          if (!parsed) continue;
          if (params.sender && !parsed.sender.includes(params.sender)) continue;
          allParsed.push(parsed);
        }

        const includeIndices = new Set<number>();
        for (let i = 0; i < allParsed.length; i++) {
          if (allParsed[i].content.includes(params.keyword)) {
            for (let j = Math.max(0, i - contextLines); j <= Math.min(allParsed.length - 1, i + contextLines); j++) {
              includeIndices.add(j);
            }
          }
        }

        for (const idx of Array.from(includeIndices).sort((a, b) => a - b)) {
          messages.push({ ...allParsed[idx], session: dir.name });
        }
      } else {
        for (const line of lines) {
          const parsed = parseMsgLine(line);
          if (!parsed) continue;
          if (params.sender && !parsed.sender.includes(params.sender)) continue;
          if (params.keyword && !parsed.content.includes(params.keyword)) continue;
          messages.push({ ...parsed, session: dir.name });
        }
      }

      if (messages.length >= limit * 2) break;
    }
  }

  messages.sort((a, b) => b.time.localeCompare(a.time));
  return messages.slice(0, limit);
}

// ─── LLM QA extraction ─────────────────────────────────────────────────────

type LLMProvider = {
  createMessage(params: {
    model: string;
    max_tokens: number;
    system: string;
    tools: any[];
    messages: Array<{ role: string; content: string }>;
  }): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

let _getProvider: (() => LLMProvider) | null = null;
let _getModelName: (() => string) | null = null;

export function setLLMProvider(getProvider: () => LLMProvider, getModelName: () => string): void {
  _getProvider = getProvider;
  _getModelName = getModelName;
}

export async function extractWeworkQA(params: {
  topics?: string[];
  people?: string[];
  startDate?: string;
  endDate?: string;
  session?: string;
  limit?: number;
}): Promise<QAPair[]> {
  const limit = params.limit ?? 10;

  let allMessages: WeworkMessage[] = [];
  const messageIds = new Set<string>();

  if (params.topics && params.topics.length > 0) {
    for (const keyword of params.topics) {
      const messages = await fetchWeworkMessages({
        session: params.session,
        keyword: keyword.trim(),
        limit: 500,
      });
      for (const msg of messages) {
        const msgId = `${msg.time}-${msg.sender}-${msg.content}`;
        if (!messageIds.has(msgId)) {
          messageIds.add(msgId);
          allMessages.push(msg);
        }
      }
    }
  } else {
    allMessages = await fetchWeworkMessages({
      session: params.session,
      limit: 500,
    });
  }

  if (allMessages.length === 0) return [];

  // Date & people filtering
  let filtered = allMessages;

  if (params.startDate) {
    filtered = filtered.filter(m => m.time >= params.startDate!);
  }
  if (params.endDate) {
    filtered = filtered.filter(m => m.time <= params.endDate! + ' 23:59:59');
  }
  if (params.people && params.people.length > 0) {
    filtered = filtered.filter(m =>
      params.people!.some(p => m.sender.includes(p))
    );
  }

  if (filtered.length === 0) return [];

  return extractQAWithLLM(filtered, params.topics?.join('、'), limit);
}

async function extractQAWithLLM(
  messages: WeworkMessage[],
  topic: string | undefined,
  limit: number
): Promise<QAPair[]> {
  if (!_getProvider || !_getModelName) {
    throw new Error('LLM provider not injected');
  }

  const conversationText = messages
    .map(m => `[${m.time}] ${m.sender}: ${m.content}`)
    .join('\n');

  const topicHint = topic ? `\n提取主题：${topic}\n请重点关注与该主题相关的问答。` : '';
  const prompt = `从以下企微群聊记录中提取有价值的 Q&A 对。${topicHint}

要求：
- 提取真实的业务问答（技术问题、流程咨询、故障排查等）
- 问题和答案应泛化为通用知识，去除客户特定信息（具体 IP、账号、公司名等）
- 跳过寒暄、确认、会议安排等无知识价值的内容
- 最多提取 ${limit} 个最有价值的 Q&A 对

聊天记录：
${conversationText}

以 JSON 数组返回，每个元素包含：
- question: 问题（泛化为通用问题）
- answer: 答案（综合多条消息，简明扼要，300 字以内）
- tags: 标签数组（1-3 个）
- time: 问题时间（YYYY-MM-DD HH:MM:SS）
- questioner: 提问人
- answerer: 回答人
- context: 业务场景说明

只返回 JSON 数组，不要其他内容。无符合标准的 Q&A 则返回 []。`;

  const provider = _getProvider();
  const response = await provider.createMessage({
    model: _getModelName(),
    max_tokens: 16000,
    system: '你是一个业务知识提取专家。请直接返回 JSON 结果，不要使用 markdown 代码块包裹，不要使用 <think> 标签或其他思考过程标记。',
    tools: [],
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response.content[0];
  if (content.type !== 'text' || !content.text) return [];

  const qaPairs = parseLLMJsonArray<{
    question: string;
    answer: string;
    tags?: string[];
    time: string;
    questioner: string;
    answerer: string;
    context?: string;
  }>(content.text);

  return qaPairs.map(qa => {
    const msg = messages.find(m => m.time === qa.time);
    return {
      ...qa,
      session: msg?.session || messages[0]?.session || 'unknown',
    };
  });
}

// ─── JSON repair (self-contained copy for plugin isolation) ─────────────────

function parseLLMJsonArray<T = unknown>(raw: string): T[] {
  let text = stripLLMWrapper(raw);

  const firstBracket = text.indexOf('[');
  if (firstBracket < 0) throw new Error('未找到 JSON 数组');
  if (firstBracket > 0) text = text.substring(firstBracket);

  text = fixJsonStringValues(text);
  text = text
    .replace(/,\s*]/g, ']')
    .replace(/,\s*}/g, '}')
    .trim();

  if (text === '[]') return [];

  try {
    return JSON.parse(text);
  } catch {
    const repaired = repairTruncatedJsonArray(text);
    if (repaired) return JSON.parse(repaired);
    throw new Error('JSON 解析失败且无法修复');
  }
}

function stripLLMWrapper(raw: string): string {
  let text = raw.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();
  return text;
}

function fixJsonStringValues(text: string): string {
  try { JSON.parse(text); return text; } catch {}

  let result = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '"') { result += text[i]; i++; continue; }
    result += text[i]; i++;

    while (i < text.length) {
      const c = text[i];
      if (c === '\\') { result += c; i++; if (i < text.length) { result += text[i]; i++; } continue; }
      if (c === '"') {
        if (isClosingQuote(text, i + 1)) { result += c; i++; break; }
        result += '\\"'; i++; continue;
      }
      if (c.charCodeAt(0) < 0x20) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        result += c === '\t' ? '\\t' : '\\n';
        i++; continue;
      }
      result += c; i++;
    }
  }
  return result;
}

function isClosingQuote(text: string, pos: number): boolean {
  let j = pos;
  while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
  if (j >= text.length) return true;
  return ',}]:'.includes(text[j]);
}

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
    if (depth === 1 && ch === '}') lastCompleteObjectEnd = i;
  }

  if (lastCompleteObjectEnd <= 0) return null;
  return (trimmed.substring(0, lastCompleteObjectEnd + 1) + ']').replace(/,\s*]$/, ']');
}
