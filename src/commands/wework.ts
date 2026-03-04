import { queryInfluxRaw, isInfluxConfigured } from '../db/influxdb.js';
import { log } from '../utils/logger.js';

export interface WeworkMessage {
  time: string;
  session: string;
  sender: string;
  content: string;
}

/**
 * 查询企微聊天记录
 * @param session 群聊名称（模糊匹配）
 * @param sender  发送人（精确匹配，可选）
 * @param keyword 消息内容关键词（可选）
 * @param limit   返回条数上限，默认100
 */
export async function fetchWeworkMessages(params: {
  session?: string;
  sender?: string;
  keyword?: string;
  limit?: number;
}): Promise<WeworkMessage[]> {
  if (!isInfluxConfigured()) throw new Error('InfluxDB 未配置');

  const conditions: string[] = [];

  if (params.session) {
    // 使用正则模糊匹配群聊名称
    const escaped = params.session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    conditions.push(`"session" =~ /${escaped}/`);
  }
  if (params.sender) {
    conditions.push(`"sender" = '${params.sender.replace(/'/g, "\\'")}'`);
  }
  if (params.keyword) {
    const escaped = params.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    conditions.push(`"content" =~ /${escaped}/`);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 100;

  const q = `SELECT "time", "session", "sender", "content" FROM "wework"${where} ORDER BY time DESC LIMIT ${limit}`;

  const rows = await queryInfluxRaw('messages', q);

  return rows.map(r => ({
    time: r.time ?? '',
    session: r.session ?? '',
    sender: r.sender ?? '',
    content: r.content ?? r.message ?? '',
  }));
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
      const t = r.time ? r.time.replace('T', ' ').replace(/\.\d+Z$/, '') : '';
      log.print(`[${t}] ${r.session} | ${r.sender}: ${r.content}`);
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
