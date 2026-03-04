import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { log } from '../utils/logger.js';

const DUMP_DIR = '/Users/simon/Documents/my/XBase/dump/wework';

export interface WeworkMessage {
  time: string;
  session: string;
  sender: string;
  content: string;
}

/**
 * 查询企微聊天记录（从本地 dump 目录读取）
 * @param session 群聊名称（模糊匹配）
 * @param sender  发送人（模糊匹配，可选）
 * @param keyword 消息内容关键词（可选）
 * @param limit   返回条数上限，默认100
 */
export async function fetchWeworkMessages(params: {
  session?: string;
  sender?: string;
  keyword?: string;
  limit?: number;
}): Promise<WeworkMessage[]> {
  const limit = params.limit ?? 100;
  const entries = readdirSync(DUMP_DIR, { withFileTypes: true });

  const sessionDirs: { name: string; path: string }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (params.session && !e.name.toLowerCase().includes(params.session.toLowerCase())) continue;
    sessionDirs.push({ name: e.name, path: join(DUMP_DIR, e.name) });
  }

  const messages: WeworkMessage[] = [];

  for (const dir of sessionDirs) {
    const files = readdirSync(dir.path)
      .filter(f => f.endsWith('.txt'))
      .sort()
      .reverse();

    for (const file of files) {
      const lines = readFileSync(join(dir.path, file), 'utf-8').split('\n');
      for (const line of lines) {
        const parsed = parseMsgLine(line);
        if (!parsed) continue;
        if (params.sender && !parsed.sender.includes(params.sender)) continue;
        if (params.keyword && !parsed.content.includes(params.keyword)) continue;
        messages.push({ ...parsed, session: dir.name });
      }
      if (messages.length >= limit * 2) break;
    }
  }

  messages.sort((a, b) => b.time.localeCompare(a.time));
  return messages.slice(0, limit);
}

const MSG_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]: (.+?): ([\s\S]+)$/;

function parseMsgLine(line: string): { time: string; sender: string; content: string } | null {
  const m = MSG_RE.exec(line);
  if (!m) return null;
  return { time: m[1], sender: m[2], content: m[3] };
}

/**
 * CLI 命令处理
 */
export async function wework(args: string): Promise<void> {
  const params = parseArgs(args);
  try {
    const rows = await fetchWeworkMessages({
      session: params.session,
      sender: params.sender,
      keyword: params.keyword,
      limit: params.limit ? Number(params.limit) : undefined,
    });

    if (rows.length === 0) {
      log.print('未查询到企微聊天记录');
      return;
    }

    log.print(`查询到 ${rows.length} 条聊天记录：\n`);
    for (const r of rows.reverse()) {
      log.print(`[${r.time}] ${r.session} | ${r.sender}: ${r.content}`);
    }
  } catch (err: any) {
    log.print(err.message);
  }
}

function parseArgs(args: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)=(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    params[m[1].toLowerCase()] = m[2];
  }
  return params;
}
