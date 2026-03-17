/**
 * 企业微信 Bot 入口
 *
 * 使用方式：
 * 1. 配置 config/monitor.json 中的 wework 项
 * 2. 启动服务：npx tsx src/wework-entry.ts
 *
 * 环境变量：
 * - WEWORK_PORT: HTTP 端口（默认 3002）
 * - WEWORK_ADMIN_IDS: 管理员用户 ID 列表（逗号分隔）
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import { initSchema } from './db/schema.js';
import { initProviders } from './llm/provider.js';
import { setCurrentUser } from './auth/rbac.js';
import { closeDb } from './db/connection.js';
import { startWeworkBot, stopWeworkBot, handleWebhookRequest } from './wework/bot.js';
import { setAdminIds } from './wework/session.js';
import { log } from './utils/logger.js';

const PORT = parseInt(process.env.WEWORK_PORT || '3002', 10);

async function main() {
  log.print('\n' + '='.repeat(40));
  log.print('  OTC Claw — 企微 Bot');
  log.print('='.repeat(40) + '\n');

  initSchema();

  const llmReady = await initProviders();
  if (!llmReady) {
    log.error('LLM 未配置，请在 .env 中配置 ANTHROPIC_API_KEY 或 MINIMAX_API_KEY');
    process.exit(1);
  }

  setCurrentUser({ id: 'admin-001', username: 'admin', role: 'admin' });

  // 配置管理员 ID
  const adminIds = (process.env.WEWORK_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (adminIds.length > 0) {
    setAdminIds(adminIds);
    log.info(`[企微] 管理员 ID: ${adminIds.join(', ')}`);
  }

  await startWeworkBot();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const query = Object.fromEntries(url.searchParams.entries());
    const method = req.method || 'GET';

    // 健康检查
    if (method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // 企微回调路径匹配（支持任意路径，方便部署在不同环境）
    // 企微会调用配置的 URL，如 /pubapi/v1/WxWorkAiBots/Callbacks/ByIdent/xxx
    // 只要不是 /health，都当作企微回调处理
    let body = '';
    if (method === 'POST') {
      for await (const chunk of req) {
        body += chunk;
      }
    }

    try {
      const result = await handleWebhookRequest(method, query, body);
      res.writeHead(result.status, { 'Content-Type': result.contentType });
      res.end(result.body);
    } catch (err: any) {
      log.error(`[HTTP] 处理请求出错: ${err.message}`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('success');
    }
  });

  server.listen(PORT, () => {
    log.success(`企微 Bot 服务已启动: http://localhost:${PORT}`);
    log.info(`回调 URL: https://opsys-api.gf.com.cn/pubapi/v1/WxWorkAiBots/Callbacks/ByIdent/69b375aa0c10bd914452c3b9`);
    log.dim(`（需要通过 nginx 反代或网关路由到本服务）`);
  });

  const shutdown = () => {
    log.info('\n正在关闭...');
    stopWeworkBot();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
