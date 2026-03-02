/**
 * 飞书 Bot 入口
 *
 * 使用方式：
 * 1. 配置 config/monitor.json 中的 feishu 项
 * 2. 启动服务：npx tsx src/feishu-entry.ts
 *
 * 环境变量：
 * - FEISHU_MODE: 连接模式 ws(长连接,默认) | webhook(HTTP回调)
 * - FEISHU_PORT: HTTP 端口（webhook 模式必需，ws 模式用于健康检查）
 * - FEISHU_ADMIN_IDS: 管理员用户 ID 列表（可选，逗号分隔）
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import { initSchema } from './db/schema.js';
import { initProviders } from './llm/provider.js';
import { setCurrentUser } from './auth/rbac.js';
import { closeDb } from './db/connection.js';
import { startFeishuBot, stopFeishuBot, handleWebhookRequest, type FeishuBotMode } from './feishu/bot.js';
import { log } from './utils/logger.js';

const MODE = (process.env.FEISHU_MODE || 'ws') as FeishuBotMode;
const PORT = parseInt(process.env.FEISHU_PORT || '3001', 10);

async function main() {
  console.log('\n' + '='.repeat(40));
  log.info('  衍语 (YanYu) — 飞书 Bot');
  console.log('='.repeat(40) + '\n');

  initSchema();

  const llmReady = await initProviders();
  if (!llmReady) {
    log.error('LLM 未配置，请在 .env 中配置 ANTHROPIC_API_KEY 或 MINIMAX_API_KEY');
    process.exit(1);
  }

  setCurrentUser({ id: 'admin-001', username: 'admin', role: 'admin' });

  if (MODE === 'ws') {
    // ── 长连接模式 ──
    await startFeishuBot({ mode: 'ws' });

    // 优雅退出
    const shutdown = () => {
      log.info('\n正在关闭...');
      stopFeishuBot();
      closeDb();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } else {
    // ── Webhook 模式 ──
    await startFeishuBot({ mode: 'webhook' });

    const server = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Feishu-Signature, X-Feishu-Timestamp, X-Feishu-Nonce');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/webhook/feishu') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }

        try {
          const jsonBody = JSON.parse(body);
          const headers = req.headers as Record<string, string | string[] | undefined>;
          const result = await handleWebhookRequest(headers, jsonBody);

          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.body));
        } catch (err: any) {
          log.error(`[HTTP] 处理请求出错: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // 健康检查
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    server.listen(PORT, () => {
      log.success(`飞书 Bot 服务已启动: http://localhost:${PORT}/webhook/feishu`);
    });

    // 优雅退出
    const shutdown = () => {
      log.info('\n正在关闭...');
      stopFeishuBot();
      server.close(() => {
        closeDb();
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

main();
