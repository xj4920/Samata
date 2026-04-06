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

  return { servers };
}

async function connectServer(name: string, srv: McpServerConfig): Promise<void> {
  const transport = srv.transport === 'sse'
    ? new SSEClientTransport(new URL(srv.url))
    : new StdioClientTransport({
        command: (srv as McpServerStdio).command,
        args: (srv as McpServerStdio).args ?? [],
        env: (srv as McpServerStdio).env,
      });

  const client = new Client({ name: 'samata', version: '1.0.0' });
  await client.connect(transport);

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
    try {
      await connectServer(name, srv);
    } catch (err: any) {
      log.warn(`⚠️  MCP [${name}]: 连接失败 — ${err.message}`);
    }
  }
}

export function getMcpTools(): Anthropic.Tool[] {
  return [...sessions.values()].flatMap(s => s.tools);
}

export async function callMcpTool(toolName: string, input: Record<string, unknown>): Promise<string> {
  // toolName format: mcp_<server>_<originalName>
  const match = toolName.match(/^mcp_([^_]+)_(.+)$/);
  if (!match) return JSON.stringify({ error: `无效的 MCP 工具名: ${toolName}` });

  const [, serverName, originalName] = match;
  const session = sessions.get(serverName);
  if (!session) return JSON.stringify({ error: `MCP 服务器未连接: ${serverName}` });

  try {
    const result = await session.client.callTool({ name: originalName, arguments: input });
    if (result.isError) {
      return JSON.stringify({ error: result.content });
    }
    const texts = (result.content as any[])
      .filter(c => c.type === 'text')
      .map(c => c.text as string);
    return texts.join('\n') || JSON.stringify(result.content);
  } catch (err: any) {
    return JSON.stringify({ error: `MCP 工具调用失败: ${err.message}` });
  }
}

export async function stopMcpServers(): Promise<void> {
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
