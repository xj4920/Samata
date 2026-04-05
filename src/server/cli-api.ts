import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createCliSession, destroyCliSession, listCliUsers, toCliSessionInfo } from './cli-session.js';
import { executeCliInput, executeCliStream } from './cli-executor.js';
import { log } from '../utils/logger.js';
import type { CliStreamEvent } from '../shared/cli-contract.js';

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, statusCode: number, payload: any): void {
  const text = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function startCliApiServer(port = parseInt(process.env.CLI_API_PORT || '3456', 10)): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/api/cli/users') {
        return sendJson(res, 200, { users: listCliUsers() });
      }

      if (req.method === 'POST' && url.pathname === '/api/cli/session') {
        const body = await readJson(req);
        const session = createCliSession(body.username);
        return sendJson(res, 200, {
          ok: true,
          session: toCliSessionInfo(session),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/cli/execute') {
        const body = await readJson(req);
        const result = await executeCliInput(body.sessionId, body.input || '');
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/cli/stream') {
        const body = await readJson(req);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Transfer-Encoding': 'chunked',
        });
        const emit = (event: CliStreamEvent) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        try {
          await executeCliStream(body.sessionId, body.input || '', emit);
        } catch (err: any) {
          emit({ type: 'error', message: err.message ?? String(err) });
        }
        res.end();
        return;
      }

      if (req.method === 'DELETE' && url.pathname === '/api/cli/session') {
        const body = await readJson(req);
        destroyCliSession(body.sessionId);
        return sendJson(res, 200, { ok: true });
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err: any) {
      sendJson(res, 500, { ok: false, error: err.message ?? String(err) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log.info(`[CLI API] listening on http://127.0.0.1:${port}`);
  });
  return server;
}
