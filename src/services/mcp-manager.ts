import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';

interface McpServerStdio {
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
  tools?: string[];
}

interface McpServerSse {
  transport: 'sse';
  url: string;
  description?: string;
  tools?: string[];
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
let retryTimer: NodeJS.Timeout | null = null;

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

  // Expand $ENV_VAR references in args and url
  const expand = (s: string) => s.replace(/\$(\w+)/g, (m, k) => process.env[k] ?? m);
  for (const srv of Object.values(servers)) {
    if ('args' in srv && srv.args) srv.args = srv.args.map(expand);
    if ('url' in srv) srv.url = expand(srv.url);
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
    description: t.description ?? '',
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

export function getMcpTools(): Anthropic.Tool[] {
  return [...sessions.values()].flatMap(s => s.tools);
}

export async function callMcpTool(toolName: string, input: Record<string, unknown>): Promise<string> {
  // toolName format: mcp_<server>_<originalName>
  const match = toolName.match(/^mcp_([^_]+)_(.+)$/);
  if (!match) return JSON.stringify({ error: `无效的 MCP 工具名: ${toolName}` });

  const [, serverName, originalName] = match;

  if (!sessions.has(serverName)) {
    const ok = await ensureConnected(serverName);
    if (!ok) return JSON.stringify({ error: `MCP 服务器未连接: ${serverName}` });
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
    return formatResult(await invoke());
  } catch (err: any) {
    // transport 可能已断：丢弃 session，重连一次，重试一次
    try { await sessions.get(serverName)?.client.close(); } catch {}
    sessions.delete(serverName);
    lastFailedAt.delete(serverName);
    const ok = await ensureConnected(serverName);
    if (!ok) return JSON.stringify({ error: `MCP 工具调用失败: ${err.message}` });
    try {
      return formatResult(await invoke());
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
