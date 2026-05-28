/**
 * 企业微信 Bot 独立入口
 *
 * 使用方式：
 * 1. 通过 DB bot_apps 表配置 wework 应用（/agent assign + /agent bot-app）
 * 2. 或配置环境变量 WEWORK_AIBOT_BOT_ID / WEWORK_AIBOT_SECRET（自动 seed 到 bot_apps）
 * 3. 启动服务：npx tsx src/wework-entry.ts
 *
 * 环境变量：
 * - WEWORK_PORT: 健康检查 HTTP 端口（默认 3002）
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import { initSchema } from './db/schema.js';
import { initProviders } from './llm/provider.js';
import { setCurrentUser } from './auth/rbac.js';
import { closeDb } from './db/connection.js';
import { startAllWeworkBots, stopAllWeworkBots, watchWeworkApps, stopWatchWeworkApps } from './wework/bot.js';
import { log } from './utils/logger.js';

const PORT = parseInt(process.env.WEWORK_PORT || '3002', 10);

async function main() {
  log.print('\n' + '='.repeat(40));
  log.print('  Samata — 企微 Bot（WebSocket 长连接）');
  log.print('='.repeat(40) + '\n');

  initSchema();

  const llmReady = await initProviders();
  if (!llmReady) {
    log.error('LLM 未配置，请在 .env 中配置 ANTHROPIC_API_KEY 或 MINIMAX_API_KEY');
    process.exit(1);
  }

  setCurrentUser({ id: 'admin-001', username: 'admin', role: 'admin' });

  await startAllWeworkBots();
  watchWeworkApps();

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(PORT, () => log.success(`企微 Bot 健康检查: http://localhost:${PORT}/health`));

  const shutdown = () => {
    log.info('\n正在关闭...');
    stopWatchWeworkApps();
    stopAllWeworkBots();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
