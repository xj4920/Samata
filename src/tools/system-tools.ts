import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../llm/agents/config.js';
import { TOOL_PRESETS, COMMON_SET } from '../llm/agents/config.js';
import { fetchSystemStatus } from '../commands/monitor.js';
import { areChromiumToolsDisabled } from '../runtime/chromium-tools.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'get_status_summary',
    description: '获取系统状态概览（版本、模型、服务运行状态、知识库/Skill数量、运行时长等）',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_tool_presets',
    description: '列出所有可用的工具预设（preset），用于创建 agent 时快速选择工具集',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'http_request',
    description: '发起 HTTP 请求，适合调用 REST API、获取 JSON 数据、检查服务状态。注意：返回的响应体会被截断（最多 8000 字节），不适合抓取网页正文。如需提取网页内容（新闻、研报、公告等），请使用 web_fetch。不要用它下载 PDF、Excel、Word、图片等二进制文件；这类 URL 请使用 download_file。',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: '请求 URL' },
        method: { type: 'string', description: 'HTTP 方法：GET、POST、PUT、DELETE 等，默认 GET' },
        headers: {
          type: 'object' as const,
          description: '请求头（可选），如 { "Content-Type": "application/json", "Authorization": "Bearer xxx" }',
          additionalProperties: { type: 'string' },
        },
        body: { type: 'string', description: '请求体（可选），POST/PUT 时使用，JSON 字符串或纯文本' },
        timeout: { type: 'number', description: '超时时间（毫秒），默认 10000' },
      },
      required: ['url'],
    },
  },
];

function handleStatusSummary(): string {
  return JSON.stringify(fetchSystemStatus());
}

function handleListToolPresets(): string {
  const commonTools = [...COMMON_SET];
  const presets = Object.entries(TOOL_PRESETS)
    .filter(([key]) => !(key === 'browser' && areChromiumToolsDisabled()));
  return JSON.stringify({
    common_set: {
      description: '所有 standard 模式 agent 的基础工具集',
      toolCount: commonTools.length,
      tools: commonTools,
    },
    presets: presets.map(([key, preset]) => ({
      preset: key,
      description: preset.description,
      toolCount: preset.tools.length,
      tools: preset.tools,
    })),
  });
}

async function handleHttpRequest(input: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<string> {
  const { default: axios } = await import('axios');
  const method = (input.method ?? 'GET').toUpperCase();
  const timeout = input.timeout ?? 10000;
  try {
    const resp = await axios.request({
      url: input.url,
      method,
      headers: input.headers,
      data: input.body,
      timeout,
      responseType: 'text',
      transformResponse: [(data) => data],
      validateStatus: () => true,
    });
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    const truncated = body.length > 8000 ? body.slice(0, 8000) + `\n...(已截断，原始长度 ${body.length} 字节)` : body;
    return JSON.stringify({ status: resp.status, headers: resp.headers, body: truncated });
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}

export async function handleTool(name: string, input: any, _ctx?: ToolContext): Promise<string | null> {
  switch (name) {
    case 'get_status_summary': return handleStatusSummary();
    case 'list_tool_presets': return handleListToolPresets();
    case 'http_request': return handleHttpRequest(input);
    default: return null;
  }
}
