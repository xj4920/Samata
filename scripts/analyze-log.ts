/**
 * analyze-log.ts
 * 解析 Samata 日志文件，提取所有渠道的用户提问记录并输出统计报告。
 *
 * 支持渠道：企微(wework)、飞书(feishu)、Telegram、CLI
 *
 * 用法：
 *   npx tsx scripts/analyze-log.ts                                            # 今天
 *   npx tsx scripts/analyze-log.ts logs/app-2026-04-12.log                    # 指定文件
 *   npx tsx scripts/analyze-log.ts --from=2026-04-10 --to=2026-04-15         # 日期范围
 *   npx tsx scripts/analyze-log.ts --channel=feishu                           # 只看飞书
 *   npx tsx scripts/analyze-log.ts --channel=wework --from=2026-04-10 --csv  # 组合
 *
 * 分析结果以 markdown 写入 ./logs/daily_usage/<date>.md
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join, basename } from 'path';

type Channel = 'wework' | 'feishu' | 'telegram' | 'cli';

interface UserMessage {
  time: string;
  userid: string;
  channel: Channel;
  chattype: string;   // 私聊 / 群聊
  msgtype: string;    // text / image / mixed
  agent: string;      // agent 名称（如 衍语/otcclaw）
  content: string;
}

// --- wework: cmd=aibot_msg_callback ---
const WEWORK_LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*cmd=aibot_msg_callback.*body=(\{.+)$/;
const CMD_PREFIX_RE = /^\//;
const AT_BOT_RE = /^@\S+\s*/;

// --- feishu: 多行 block ---
// [2026-04-12T02:26:13.504Z] [INFO] [飞书:tutor-bot][mnv56v0g-6106] 收到消息
const FEISHU_RECV_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[INFO\] \[飞书:([^\]]+)\]\[([^\]]+)\] 收到消息$/;
// [2026-04-12T02:26:14.358Z] [INFO] [飞书:tutor-bot][mnv56v0g-6106] AI 对话开始
const FEISHU_CHAT_START_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[INFO\] \[飞书:([^\]]+)\]\[([^\]]+)\] AI 对话开始$/;
const FEISHU_DETAIL_RE = /^\s{2,}(\w+)=(.+)$/;

// --- telegram ---
// [2026-04-12T...] [DEBUG] [TG] username: text
const TG_LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] \[DEBUG\] \[TG\] (\S+): (.+)$/;

function toUTC8(iso: string): string {
  const ms = new Date(iso).getTime() + 8 * 3600_000;
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${hh}:${mm}:${ss}`;
}

function extractWeworkContent(body: any): { msgtype: string; content: string } | null {
  const msgtype: string = body.msgtype;

  if (msgtype === 'text') {
    return { msgtype, content: body.text?.content ?? '' };
  }
  if (msgtype === 'image') {
    return { msgtype, content: '[图片消息]' };
  }
  if (msgtype === 'mixed') {
    const items: any[] = body.mixed?.msg_item ?? [];
    const parts: string[] = [];
    for (const item of items) {
      if (item.msgtype === 'text') parts.push(item.text?.content ?? '');
      else if (item.msgtype === 'image') parts.push('[图片]');
      else parts.push(`[${item.msgtype}]`);
    }
    return { msgtype, content: parts.join(' ') };
  }
  return null;
}

function parseWeworkLine(line: string): UserMessage | null {
  const m = WEWORK_LINE_RE.exec(line);
  if (!m) return null;

  const [, isoTime, jsonStr] = m;
  let body: any;
  try { body = JSON.parse(jsonStr); } catch { return null; }

  const extracted = extractWeworkContent(body);
  if (!extracted) return null;

  let { content } = extracted;
  if (body.chattype === 'group') content = content.replace(AT_BOT_RE, '');
  if (CMD_PREFIX_RE.test(content.trim())) return null;
  if (!content.trim()) return null;

  return {
    time: toUTC8(isoTime),
    userid: body.from?.userid ?? 'unknown',
    channel: 'wework',
    chattype: body.chattype === 'group' ? '群聊' : '私聊',
    msgtype: extracted.msgtype,
    agent: '',
    content: content.trim(),
  };
}

interface FeishuBlock {
  isoTime: string;
  appName: string;
  traceId: string;
  fields: Map<string, string>;
}

function parseFeishuBlock(lines: string[], startIdx: number, re: RegExp): { block: FeishuBlock; endIdx: number } | null {
  const m = re.exec(lines[startIdx]);
  if (!m) return null;

  const [, isoTime, appName, traceId] = m;
  const fields = new Map<string, string>();
  let idx = startIdx + 1;
  while (idx < lines.length) {
    const dm = FEISHU_DETAIL_RE.exec(lines[idx]);
    if (!dm) break;
    fields.set(dm[1], dm[2]);
    idx++;
  }
  return { block: { isoTime, appName, traceId, fields }, endIdx: idx };
}

function parseTelegramLine(line: string): UserMessage | null {
  const m = TG_LINE_RE.exec(line);
  if (!m) return null;

  const [, isoTime, username, text] = m;
  if (CMD_PREFIX_RE.test(text.trim())) return null;
  if (!text.trim()) return null;

  return {
    time: toUTC8(isoTime),
    userid: username,
    channel: 'telegram',
    chattype: '私聊',
    msgtype: 'text',
    agent: '',
    content: text.trim(),
  };
}

function parseArg(args: string[], prefix: string): string | undefined {
  const hit = args.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function enumerateDateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function resolveLogPaths(args: string[]): string[] {
  const root = process.cwd();
  const filePath = args.find(a => !a.startsWith('--'));
  if (filePath) {
    const p = resolve(root, filePath);
    if (!existsSync(p)) { console.error(`文件不存在: ${p}`); process.exit(1); }
    return [p];
  }

  const fromDate = parseArg(args, '--from=');
  const toDate = parseArg(args, '--to=');

  if (fromDate || toDate) {
    const today = new Date();
    today.setHours(today.getHours() + 8);
    const todayStr = today.toISOString().slice(0, 10);
    const from = fromDate || todayStr;
    const to = toDate || todayStr;
    const dates = enumerateDateRange(from, to);
    const paths = dates
      .map(d => join(root, 'logs', `app-${d}.log`))
      .filter(p => existsSync(p));
    if (paths.length === 0) {
      console.error(`日期范围 ${from} ~ ${to} 内无日志文件`);
      process.exit(1);
    }
    return paths;
  }

  const today = new Date();
  today.setHours(today.getHours() + 8);
  const dateStr = today.toISOString().slice(0, 10);
  const defaultPath = join(root, 'logs', `app-${dateStr}.log`);
  if (!existsSync(defaultPath)) { console.error(`今日日志不存在: ${defaultPath}`); process.exit(1); }
  return [defaultPath];
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function parseAllMessages(rawLines: string[]): UserMessage[] {
  const messages: UserMessage[] = [];

  // 飞书 traceId → agent 名称映射（从 AI 对话开始 block 提取）
  const feishuAgentMap = new Map<string, string>();

  // 第一遍：收集飞书 AI 对话开始 block 的 agent 信息
  for (let i = 0; i < rawLines.length; i++) {
    const result = parseFeishuBlock(rawLines, i, FEISHU_CHAT_START_RE);
    if (result) {
      const agentField = result.block.fields.get('agent') ?? '';
      feishuAgentMap.set(result.block.traceId, agentField);
      i = result.endIdx - 1;
    }
  }

  // 第二遍：解析所有消息
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // 1. wework
    const wework = parseWeworkLine(line);
    if (wework) {
      messages.push(wework);
      continue;
    }

    // 2. feishu 收到消息 block
    const feishuResult = parseFeishuBlock(rawLines, i, FEISHU_RECV_RE);
    if (feishuResult) {
      const { block, endIdx } = feishuResult;
      i = endIdx - 1;

      const text = block.fields.get('text') ?? '';
      if (!text || CMD_PREFIX_RE.test(text.trim())) continue;

      const senderField = block.fields.get('sender') ?? 'unknown';
      const userid = senderField.split(' ')[0] || senderField;
      const chatField = block.fields.get('chat') ?? '';
      const isGroup = block.fields.get('group') === 'true' || chatField.startsWith('group:');

      const agent = feishuAgentMap.get(block.traceId) ?? '';

      messages.push({
        time: toUTC8(block.isoTime),
        userid,
        channel: 'feishu',
        chattype: isGroup ? '群聊' : '私聊',
        msgtype: 'text',
        agent,
        content: text.trim(),
      });
      continue;
    }

    // 3. telegram
    const tg = parseTelegramLine(line);
    if (tg) {
      messages.push(tg);
      continue;
    }
  }

  messages.sort((a, b) => a.time.localeCompare(b.time));
  return messages;
}

const CHANNEL_LABEL: Record<Channel, string> = {
  wework: '企微',
  feishu: '飞书',
  telegram: 'TG',
  cli: 'CLI',
};

function buildMarkdown(messages: UserMessage[], dateLabel: string): string {
  const lines: string[] = [];

  lines.push(`# Samata 使用报告 — ${dateLabel}`);
  lines.push('');
  lines.push(`## 用户提问记录 (共 ${messages.length} 条)`);
  lines.push('');
  lines.push('| # | 时间 | 用户 | 渠道 | Agent | 聊天 | 问题 |');
  lines.push('|---|------|------|------|-------|------|------|');

  messages.forEach((msg, i) => {
    const content = truncate(msg.content.replace(/\n/g, ' '), 80);
    const ch = CHANNEL_LABEL[msg.channel];
    const agent = msg.agent || '—';
    lines.push(`| ${i + 1} | ${msg.time} | ${msg.userid} | ${ch} | ${agent} | ${msg.chattype} | ${content} |`);
  });

  const userCount = new Map<string, number>();
  const typeCount = new Map<string, number>();
  const channelCount = new Map<string, number>();
  const agentCount = new Map<string, number>();

  for (const msg of messages) {
    userCount.set(msg.userid, (userCount.get(msg.userid) ?? 0) + 1);
    typeCount.set(msg.msgtype, (typeCount.get(msg.msgtype) ?? 0) + 1);
    const ch = CHANNEL_LABEL[msg.channel];
    channelCount.set(ch, (channelCount.get(ch) ?? 0) + 1);
    if (msg.agent) agentCount.set(msg.agent, (agentCount.get(msg.agent) ?? 0) + 1);
  }

  lines.push('');
  lines.push('## 统计');
  lines.push('');
  lines.push(`- 总提问数: ${messages.length}`);
  lines.push(`- 活跃用户: ${userCount.size} 人`);

  // 渠道分布
  lines.push('');
  lines.push('### 渠道分布');
  lines.push('');
  lines.push('| 渠道 | 提问数 |');
  lines.push('|------|--------|');
  for (const [ch, count] of [...channelCount.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${ch} | ${count} |`);
  }

  // Agent 分布
  if (agentCount.size > 0) {
    lines.push('');
    lines.push('### Agent 分布');
    lines.push('');
    lines.push('| Agent | 提问数 |');
    lines.push('|-------|--------|');
    for (const [agent, count] of [...agentCount.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${agent} | ${count} |`);
    }
  }

  // 用户排行
  lines.push('');
  lines.push('### 用户排行');
  lines.push('');
  lines.push('| 用户 | 提问数 |');
  lines.push('|------|--------|');
  for (const [user, count] of [...userCount.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${user} | ${count} |`);
  }

  if (typeCount.size > 1) {
    lines.push('');
    lines.push('### 消息类型');
    lines.push('');
    lines.push('| 消息类型 | 数量 |');
    lines.push('|----------|------|');
    for (const [type, count] of [...typeCount.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${type} | ${count} |`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function buildCSV(messages: UserMessage[]): string {
  const lines: string[] = ['序号,时间,用户,渠道,Agent,聊天类型,消息类型,问题'];
  messages.forEach((msg, i) => {
    const content = msg.content.replace(/"/g, '""').replace(/\n/g, ' ');
    const ch = CHANNEL_LABEL[msg.channel];
    const agent = msg.agent || '';
    lines.push(`${i + 1},"${msg.time}","${msg.userid}","${ch}","${agent}","${msg.chattype}","${msg.msgtype}","${content}"`);
  });
  return lines.join('\n') + '\n';
}

function extractDateFromPath(logPath: string): string {
  const m = basename(logPath).match(/app-(\d{4}-\d{2}-\d{2})\.log/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

const VALID_CHANNELS: Channel[] = ['wework', 'feishu', 'telegram', 'cli'];

// --- main ---
const args = process.argv.slice(2);
const csvMode = args.includes('--csv');
const channelArg = parseArg(args, '--channel=') as Channel | undefined;

if (channelArg && !VALID_CHANNELS.includes(channelArg)) {
  console.error(`无效渠道: ${channelArg}，可选: ${VALID_CHANNELS.join(', ')}`);
  process.exit(1);
}

const logPaths = resolveLogPaths(args);

const allLines: string[] = [];
for (const p of logPaths) {
  allLines.push(...readFileSync(p, 'utf8').split('\n'));
}

let messages = parseAllMessages(allLines);

if (channelArg) {
  messages = messages.filter(m => m.channel === channelArg);
}

if (messages.length === 0) {
  const suffix = channelArg ? ` (渠道: ${channelArg})` : '';
  console.log(`未找到用户提问记录${suffix}。`);
  process.exit(0);
}

const dates = logPaths.map(extractDateFromPath);
const dateLabel = dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`;
const fileTag = dates.length === 1 ? dates[0] : `${dates[0]}_${dates[dates.length - 1]}`;

const channelSuffix = channelArg ? ` (渠道: ${CHANNEL_LABEL[channelArg]})` : '';
const output = csvMode
  ? buildCSV(messages)
  : buildMarkdown(messages, dateLabel + channelSuffix);
console.log(output);

const outDir = join(process.cwd(), 'logs', 'daily_usage');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const ext = csvMode ? 'csv' : 'md';
const channelFileTag = channelArg ? `_${channelArg}` : '';
const outFile = join(outDir, `${fileTag}${channelFileTag}.${ext}`);
writeFileSync(outFile, output, 'utf8');
console.log(`\n=> 已写入 ${outFile}`);
