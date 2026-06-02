#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

loadDotEnv(resolve(ROOT, '.env.codegf'));

const server = new McpServer({
  name: 'codegf',
  version: '1.0.0',
});

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const body = readFileSync(file, 'utf8');
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function getConfig() {
  const baseUrl = (process.env.CODEGF_BASE_URL || 'https://code.gf.com.cn/api/v8').replace(/\/+$/, '');
  const token = process.env.CODEGF_PRIVATE_TOKEN || process.env.CODEGF_TOKEN || '';
  const enterprise = process.env.CODEGF_ENTERPRISE || 'gf';
  if (!token) {
    throw new Error('Missing CODEGF_PRIVATE_TOKEN. Create .env.codegf from .env.codegf.example.');
  }
  return { baseUrl, token, enterprise };
}

function buildUrl(path, query = {}) {
  const { baseUrl } = getConfig();
  let cleanPath = path.startsWith('/') ? path : `/${path}`;
  cleanPath = cleanPath.replace(/^\/api\/v8(?=\/|$)/, '');
  const url = new URL(`${baseUrl}${cleanPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function codegfRequest({ method = 'GET', path, query, body, enterprise, limitChars = 20000 }) {
  const config = getConfig();
  const url = buildUrl(path, query);
  const headers = {
    OAUTH: 'enabled',
    'Private-Token': config.token,
    enterprise: enterprise || config.enterprise,
    Accept: 'application/json',
  };
  const init = { method: method.toUpperCase(), headers };
  if (body != null && !['GET', 'HEAD'].includes(init.method)) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  let parsed = text;
  if (contentType.includes('json') && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  const result = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    method: init.method,
    url: `${url.origin}${url.pathname}${url.search}`,
    data: parsed,
  };
  const output = JSON.stringify(result, null, 2);
  return output.length > limitChars
    ? `${output.slice(0, limitChars)}\n... truncated ${output.length - limitChars} chars`
    : output;
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

const JsonObject = z.record(z.string(), z.any());

server.registerTool(
  'codegf_request',
  {
    title: 'Gitee Code API request',
    description:
      'Call code.gf.com.cn Gitee Code API 9.0. Uses base /api/v8, OAUTH enabled, Private-Token, and enterprise headers from .env.codegf.',
    inputSchema: {
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
      path: z.string().describe('API path, for example /user, /projects/:id, inner_source/projects, or /issues.'),
      query: JsonObject.optional().describe('Query parameters.'),
      body: z.any().optional().describe('JSON request body for non-GET methods.'),
      enterprise: z.string().optional().describe('Override enterprise tenant header. Defaults to CODEGF_ENTERPRISE.'),
      limitChars: z.number().int().min(1000).max(100000).default(20000),
    },
  },
  async (args) => textResult(await codegfRequest(args)),
);

server.registerTool(
  'codegf_get_current_user',
  {
    title: 'Get current CodeGF user',
    description: 'GET /user using the configured Private-Token.',
    inputSchema: {
      email: z.string().optional(),
    },
  },
  async ({ email }) => textResult(await codegfRequest({ path: '/user', query: email ? { email } : undefined })),
);

server.registerTool(
  'codegf_get_project',
  {
    title: 'Get CodeGF project',
    description: 'GET /projects/:id. The id may be a numeric project id or a repository full path.',
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe('Project id or full path. Full paths are URL-encoded automatically.'),
    },
  },
  async ({ id }) => textResult(await codegfRequest({ path: `/projects/${encodeURIComponent(String(id))}` })),
);

server.registerTool(
  'codegf_list_projects',
  {
    title: 'List CodeGF projects',
    description:
      'GET /projects, the repository list endpoint available on code.gf.com.cn. The PDF also documents inner_source/projects, but this instance returns 404 for that route.',
    inputSchema: {
      search: z.string().optional(),
      membership: z.boolean().optional(),
      owned: z.boolean().optional(),
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(100).default(20),
    },
  },
  async (query) => textResult(await codegfRequest({ path: '/projects', query })),
);

server.registerTool(
  'codegf_list_issues',
  {
    title: 'List CodeGF issues',
    description: 'GET /issues, the Gitee Code 9.0 paged open repository issues endpoint.',
    inputSchema: {
      assignee_username: z.string().optional(),
      author_username: z.string().optional(),
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(100).default(20),
    },
  },
  async (query) => textResult(await codegfRequest({ path: '/issues', query })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
