import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';
import { getContextAgent } from '../runtime/execution-context.js';
import { chromiumToolsDisabledMessage, isChromiumMcpServerDisabled } from '../runtime/chromium-tools.js';

interface McpServerBase {
  description?: string;
  tools?: string[];
  /** Agent names this MCP server is exposed to. Omitted means globally available. */
  agents?: string[];
}

interface McpServerStdio extends McpServerBase {
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpServerSse extends McpServerBase {
  transport: 'sse';
  url: string;
}

type McpServerConfig = McpServerStdio | McpServerSse;

interface McpServersConfig {
  servers: Record<string, McpServerConfig>;
}

interface McpSession {
  client: Client;
  tools: Anthropic.Tool[];
}

const sessions = new Map<string, McpSession>();
const serverConfigs = new Map<string, McpServerConfig>();
const inflightConnects = new Map<string, Promise<void>>();
const lastFailedAt = new Map<string, number>();
const RECONNECT_COOLDOWN_MS = 10_000;
const BACKGROUND_RETRY_INTERVAL_MS = 30_000;
const DEVTOOLS_HINT = '\n\n⚠️ 成功仅表示浏览器指令已发送，不保证页面状态已按预期改变。如果重复操作后页面无变化，请停止使用浏览器工具，基于当前已有的信息直接给出答复。';
const DEVTOOLS_STOP_HINT = '不要继续猜测或重复打开 URL；请基于当前已有信息直接回答，必要时说明外部页面不可用。';
const MAX_REPEATED_DEVTOOLS_NAVIGATIONS = 3;
const REPEATED_DEVTOOLS_NAVIGATION_WINDOW_MS = 5 * 60_000;
let retryTimer: NodeJS.Timeout | null = null;

let lastDevtoolsNavigation: { url: string; count: number; at: number } | null = null;

async function ensureConnected(name: string): Promise<boolean> {
  if (sessions.has(name)) return true;
  const srv = serverConfigs.get(name);
  if (!srv) return false;
  if (Date.now() - (lastFailedAt.get(name) ?? 0) < RECONNECT_COOLDOWN_MS) return false;

  let p = inflightConnects.get(name);
  if (!p) {
    p = (async () => {
      try {
        await connectServer(name, srv);
        lastFailedAt.delete(name);
      } catch (err: any) {
        lastFailedAt.set(name, Date.now());
        log.warn(`⚠️  MCP [${name}]: 重连失败 — ${err.message}`);
        throw err;
      } finally {
        inflightConnects.delete(name);
      }
    })();
    inflightConnects.set(name, p);
  }
  try { await p; return true; } catch { return false; }
}

function loadConfig(): McpServersConfig {
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dir, '../..');
  const servers: Record<string, McpServerConfig> = {};

  // Load config/mcp-servers.json (project-specific, SSE or stdio)
  const customPath = path.join(root, 'config/mcp-servers.json');
  if (fs.existsSync(customPath)) {
    const custom = JSON.parse(fs.readFileSync(customPath, 'utf-8')) as McpServersConfig;
    Object.assign(servers, custom.servers);
  }

  // Load .mcp.json (standard MCP format, stdio only)
  const mcpJsonPath = path.join(root, '.mcp.json');
  if (fs.existsSync(mcpJsonPath)) {
    const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as {
      mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    };
    for (const [name, srv] of Object.entries(mcpJson.mcpServers ?? {})) {
      servers[name] = { command: srv.command, args: srv.args, env: srv.env };
    }
  }

  // Expand $ENV_VAR references in args, url and explicit env values.
  const expand = (s: string) => s.replace(/\$(\w+)/g, (m, k) => process.env[k] ?? m);
  for (const srv of Object.values(servers)) {
    if ('args' in srv && srv.args) srv.args = srv.args.map(expand);
    if ('url' in srv) srv.url = expand(srv.url);
    if ('env' in srv && srv.env) {
      srv.env = Object.fromEntries(Object.entries(srv.env).map(([k, v]) => [k, expand(v)]));
    }
  }

  return { servers };
}

async function connectServer(name: string, srv: McpServerConfig): Promise<void> {
  const transport = srv.transport === 'sse'
    ? new SSEClientTransport(new URL(srv.url))
    : new StdioClientTransport({
        command: (srv as McpServerStdio).command,
        args: (srv as McpServerStdio).args ?? [],
        env: { ...process.env, ...(srv as McpServerStdio).env } as Record<string, string>,
      });

  const client = new Client({ name: 'samata', version: '1.0.0' });
  await client.connect(transport, { timeout: 120_000 });

  const { tools } = await client.listTools();
  const allowSet = srv.tools ? new Set(srv.tools) : null;
  const filtered = allowSet ? tools.filter(t => allowSet.has(t.name)) : tools;
  const anthropicTools: Anthropic.Tool[] = filtered.map(t => ({
    name: `mcp_${name}_${t.name}`,
    description: buildMcpToolDescription(name, t.name, t.description ?? ''),
    input_schema: (t.inputSchema as Anthropic.Tool['input_schema']) ?? { type: 'object', properties: {}, required: [] },
  }));

  sessions.set(name, { client, tools: anthropicTools });
  const label = srv.transport === 'sse' ? srv.url : (srv as McpServerStdio).command;
  const filterNote = allowSet ? ` (已过滤，服务端共 ${tools.length} 个)` : '';
  log.info(`✅ MCP [${name}] (${label}): 已连接，${anthropicTools.length} 个工具${filterNote}`);
}

export async function initMcpServers(): Promise<void> {
  const config = loadConfig();
  for (const [name, srv] of Object.entries(config.servers)) {
    if (isChromiumMcpServerDisabled(name)) {
      serverConfigs.delete(name);
      lastFailedAt.delete(name);
      log.info(`MCP [${name}]: 已跳过 — ${chromiumToolsDisabledMessage()}`);
      continue;
    }
    serverConfigs.set(name, srv);
    try {
      await connectServer(name, srv);
    } catch (err: any) {
      lastFailedAt.set(name, Date.now());
      log.warn(`⚠️  MCP [${name}]: 连接失败 — ${err.message}`);
    }
  }
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = setInterval(() => {
    for (const name of serverConfigs.keys()) {
      if (!sessions.has(name)) ensureConnected(name).catch(() => {});
    }
  }, BACKGROUND_RETRY_INTERVAL_MS);
  retryTimer.unref?.();
}

function isServerAllowedForAgent(srv: McpServerConfig | undefined, agentName?: string): boolean {
  if (!srv?.agents) return true;
  if (!agentName) return true;
  return srv.agents.includes(agentName);
}

export function getMcpTools(agentName?: string): Anthropic.Tool[] {
  return [...sessions.entries()]
    .filter(([name]) => !isChromiumMcpServerDisabled(name))
    .filter(([name]) => isServerAllowedForAgent(serverConfigs.get(name), agentName))
    .flatMap(([, session]) => session.tools);
}

export function isMcpToolAllowedForAgent(toolName: string, agentName?: string): boolean {
  const match = toolName.match(/^mcp_([^_]+)_(.+)$/);
  if (!match) return true;
  const serverName = match[1];
  if (isChromiumMcpServerDisabled(serverName)) return false;
  const srv = serverConfigs.get(serverName);
  if (!srv) return false;
  return isServerAllowedForAgent(srv, agentName);
}

function buildMcpToolDescription(serverName: string, toolName: string, description: string): string {
  if (serverName !== 'devtools') return description;
  if (toolName !== 'navigate_page' && toolName !== 'new_page') return description;
  return [
    description,
    '约束：只能打开用户明确给出的 URL、搜索结果/页面快照/HTTP 响应中真实出现的 URL，禁止按网站格式猜测新闻、研报、公告详情页 URL。若没有可信 URL，请先搜索或基于已有信息回答。',
  ].filter(Boolean).join('\n\n');
}

function getInputUrl(input: Record<string, unknown>): string | undefined {
  return typeof input.url === 'string' ? input.url.trim() : undefined;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url.trim();
  }
}

function mcpError(error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ error, ...extra });
}

function isJsonErrorPayload(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return !!parsed && typeof parsed === 'object' && 'error' in parsed;
  } catch {
    return false;
  }
}

function isSuspiciousGeneratedUrl(url: string): boolean {
  return [
    /\b1234567\d*\b/,
    /\/doc-[a-z0-9_-]*1234567\d*\.s?html(?:[?#].*)?$/i,
    /\/t\d{8}_1234567\d*\.html(?:[?#].*)?$/i,
    /\b(?:example|placeholder|dummy)\b/i,
  ].some(pattern => pattern.test(url));
}

function guardDevtoolsNavigation(originalName: string, input: Record<string, unknown>): string | null {
  if (originalName !== 'navigate_page' && originalName !== 'new_page') return null;
  const rawUrl = getInputUrl(input);
  if (!rawUrl) return null;

  const url = normalizeUrl(rawUrl);
  if (isSuspiciousGeneratedUrl(url)) {
    return mcpError('疑似模型编造的占位 URL，已拒绝打开', {
      url,
      hint: DEVTOOLS_STOP_HINT,
    });
  }

  if (/^https?:\/\/(www\.)?google\.[a-z.]+\//i.test(url)) {
    return mcpError('Google 搜索在服务器 IP 上会触发验证码，已拒绝。请改用 web_search 工具或通过浏览器打开 bing.com', { url });
  }

  const now = Date.now();
  const isSameRecentUrl = lastDevtoolsNavigation?.url === url
    && now - lastDevtoolsNavigation.at <= REPEATED_DEVTOOLS_NAVIGATION_WINDOW_MS;

  let navigationState: { url: string; count: number; at: number };
  if (isSameRecentUrl) {
    navigationState = {
      url,
      count: (lastDevtoolsNavigation?.count ?? 0) + 1,
      at: lastDevtoolsNavigation?.at ?? now,
    };
  } else {
    navigationState = { url, count: 1, at: now };
  }
  lastDevtoolsNavigation = navigationState;

  if (navigationState.count >= MAX_REPEATED_DEVTOOLS_NAVIGATIONS) {
    return mcpError('同一 URL 已被重复打开多次，疑似浏览器检索无进展，已停止继续导航', {
      url,
      count: navigationState.count,
      hint: DEVTOOLS_STOP_HINT,
    });
  }

  return null;
}

function classifyInvalidDevtoolsResult(originalName: string, input: Record<string, unknown>, text: string): string | null {
  const url = getInputUrl(input);
  const checks: Array<[RegExp, string]> = [
    [/Unable to navigate[\s\S]*Navigation timeout/i, '页面导航超时'],
    [/chrome-error:\/\/chromewebdata/i, 'Chrome 返回错误页'],
    [/RootWebArea\s+busy\b/m, '页面仍在加载中（busy）'],
    [/RootWebArea\s+"(?:页面没有找到|404[^"]*|[^"]*404 Not Found[^"]*)"/i, '目标页面不存在'],
    [/StaticText\s+"页面没有找到/i, '目标页面不存在'],
    [/\b(?:404 Not Found|This site can.?t be reached|ERR_[A-Z_]+)\b/i, '目标页面加载失败'],
  ];

  for (const [pattern, reason] of checks) {
    if (pattern.test(text)) {
      const target = url ? `: ${url}` : '';
      return `${originalName} 返回无效页面（${reason}${target}）`;
    }
  }

  return null;
}

function formatMcpResult(serverName: string, originalName: string, input: Record<string, unknown>, text: string): string {
  if (serverName !== 'devtools') return text;
  if (isJsonErrorPayload(text)) return text;

  const invalidReason = classifyInvalidDevtoolsResult(originalName, input, text);
  if (invalidReason) {
    return mcpError(invalidReason, { hint: DEVTOOLS_STOP_HINT });
  }

  return text + DEVTOOLS_HINT;
}

export async function callMcpTool(toolName: string, input: Record<string, unknown>): Promise<string> {
  // toolName format: mcp_<server>_<originalName>
  const match = toolName.match(/^mcp_([^_]+)_(.+)$/);
  if (!match) return JSON.stringify({ error: `无效的 MCP 工具名: ${toolName}` });

  const [, serverName, originalName] = match;
  if (isChromiumMcpServerDisabled(serverName)) {
    return JSON.stringify({ error: chromiumToolsDisabledMessage() });
  }
  const agentName = getContextAgent()?.name;
  if (agentName && !isMcpToolAllowedForAgent(toolName, agentName)) {
    return JSON.stringify({ error: `MCP 工具 ${toolName} 未授权给当前 agent: ${agentName}` });
  }

  if (!sessions.has(serverName)) {
    const ok = await ensureConnected(serverName);
    if (!ok) return JSON.stringify({ error: `MCP 服务器未连接: ${serverName}` });
  }

  if (serverName === 'devtools') {
    const guarded = guardDevtoolsNavigation(originalName, input);
    if (guarded) return guarded;
  }

  const invoke = async () => {
    const session = sessions.get(serverName)!;
    return session.client.callTool({ name: originalName, arguments: input });
  };

  const formatResult = (result: Awaited<ReturnType<typeof invoke>>): string => {
    if (result.isError) return JSON.stringify({ error: result.content });
    const texts = (result.content as any[])
      .filter(c => c.type === 'text')
      .map(c => c.text as string);
    return texts.join('\n') || JSON.stringify(result.content);
  };

  try {
    return formatMcpResult(serverName, originalName, input, formatResult(await invoke()));
  } catch (err: any) {
    // transport 可能已断：丢弃 session，重连一次，重试一次
    try { await sessions.get(serverName)?.client.close(); } catch {}
    sessions.delete(serverName);
    lastFailedAt.delete(serverName);
    const ok = await ensureConnected(serverName);
    if (!ok) return JSON.stringify({ error: `MCP 工具调用失败: ${err.message}` });
    try {
      return formatMcpResult(serverName, originalName, input, formatResult(await invoke()));
    } catch (err2: any) {
      return JSON.stringify({ error: `MCP 工具调用失败（重试后）: ${err2.message}` });
    }
  }
}

export async function stopMcpServers(): Promise<void> {
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  inflightConnects.clear();
  for (const [name, session] of sessions) {
    try {
      await session.client.close();
    } catch {
      // ignore
    }
    log.dim(`MCP [${name}]: 已断开`);
  }
  sessions.clear();
}
