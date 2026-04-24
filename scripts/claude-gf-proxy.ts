/**
 * Claude Code -> 广发 Anthropic 网关的本地拍平代理
 *
 * 为什么需要它：
 *   广发 /api/anthropic/v1/messages 只接受 tool_result.content 为 string，
 *   而 Claude Code 默认发 ContentBlock[]。代理把数组拍平成字符串再转发。
 *   等广发升级支持数组后，settings.json 里把 ANTHROPIC_BASE_URL 改回
 *   http://llm.smart-zone-dev.gf.com.cn/api/anthropic 即可删除本代理。
 */

import 'dotenv/config';
import http from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

const UPSTREAM = (
  process.env.CLAUDE_PROXY_UPSTREAM ||
  'http://llm.smart-zone-dev.gf.com.cn/api/anthropic'
).replace(/\/+$/, '');

const PORT = Number(process.env.CLAUDE_PROXY_PORT || 3458);
const HOST = process.env.CLAUDE_PROXY_HOST || '127.0.0.1';
const GF_API_KEY = process.env.GF_API_KEY;

if (!GF_API_KEY) {
  console.error('[claude-gf-proxy] 缺少 GF_API_KEY，请在 .env 中设置');
  process.exit(1);
}

const upstreamUrl = new URL(UPSTREAM);
const isHttps = upstreamUrl.protocol === 'https:';
const requestFn = isHttps ? httpsRequest : httpRequest;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

interface ToolResultBlock {
  type: 'tool_result';
  content?: unknown;
  [k: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 将 tool_result.content 从 ContentBlock[] 拍平成 string。
 * - text 块 -> 直接取 .text
 * - 其他（image 等） -> JSON.stringify 作为占位，保持信息不丢
 * - 字符串直接保留
 */
function flattenBlocks(blocks: unknown[]): string {
  return blocks
    .map((b) => {
      if (typeof b === 'string') return b;
      if (isRecord(b) && b.type === 'text' && typeof b.text === 'string') {
        return b.text;
      }
      return JSON.stringify(b);
    })
    .join('\n');
}

function flattenToolResults(body: unknown): { body: unknown; flattened: number } {
  let flattened = 0;
  if (!isRecord(body)) return { body, flattened };
  const messages = body.messages;
  if (!Array.isArray(messages)) return { body, flattened };

  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === 'tool_result' &&
        Array.isArray((block as ToolResultBlock).content)
      ) {
        (block as ToolResultBlock).content = flattenBlocks(
          (block as ToolResultBlock).content as unknown[]
        );
        flattened++;
      }
    }
  }
  return { body, flattened };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function buildUpstreamHeaders(
  incoming: http.IncomingHttpHeaders,
  bodyLen: number
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    // 丢掉 hop-by-hop 和鉴权相关（由我们注入）
    if (
      lower === 'host' ||
      lower === 'connection' ||
      lower === 'content-length' ||
      lower === 'x-api-key' ||
      lower === 'authorization' ||
      lower === 'accept-encoding'
    ) {
      continue;
    }
    out[k] = v;
  }
  out['host'] = upstreamUrl.host;
  out['x-api-key'] = GF_API_KEY as string;
  out['authorization'] = `Bearer ${GF_API_KEY}`;
  out['content-length'] = String(bodyLen);
  return out;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const urlPath = req.url || '/';

  try {
    const rawBody = await readBody(req);
    let outBody: Buffer = rawBody;
    let flattenedCount = 0;

    const contentType = (req.headers['content-type'] || '').toString();
    if (rawBody.length > 0 && contentType.includes('application/json')) {
      try {
        const parsed: unknown = JSON.parse(rawBody.toString('utf-8'));
        const { body: mutated, flattened } = flattenToolResults(parsed);
        flattenedCount = flattened;
        outBody = Buffer.from(JSON.stringify(mutated), 'utf-8');
      } catch (e) {
        console.warn(
          `[claude-gf-proxy] JSON parse failed, forwarding raw: ${(e as Error).message}`
        );
      }
    }

    const targetPath =
      upstreamUrl.pathname.replace(/\/+$/, '') + urlPath;

    const upstreamReq = requestFn(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        method: req.method,
        path: targetPath,
        headers: buildUpstreamHeaders(req.headers, outBody.length),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => {
          const ms = Date.now() - started;
          console.log(
            `[claude-gf-proxy] ${req.method} ${urlPath} -> ${upstreamRes.statusCode} ${ms}ms flattened=${flattenedCount}`
          );
        });
      }
    );

    upstreamReq.on('error', (err) => {
      console.error(`[claude-gf-proxy] upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end(`Upstream error: ${err.message}`);
    });

    upstreamReq.end(outBody);
  } catch (err) {
    console.error(`[claude-gf-proxy] handler error:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`Proxy error: ${(err as Error).message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `[claude-gf-proxy] listening on http://${HOST}:${PORT} -> ${UPSTREAM}`
  );
});

process.on('SIGINT', () => {
  console.log('[claude-gf-proxy] SIGINT, shutting down');
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  console.log('[claude-gf-proxy] SIGTERM, shutting down');
  server.close(() => process.exit(0));
});
