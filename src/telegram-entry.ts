import 'dotenv/config';
import { initSchema } from './db/schema.js';
import { initProviders } from './llm/provider.js';
import { setCurrentUser } from './auth/rbac.js';
import { closeDb } from './db/connection.js';
import { startTelegramBot, stopTelegramBot } from './telegram/bot.js';
import { log } from './utils/logger.js';

async function main() {
  initSchema();

  const llmReady = await initProviders();
  if (!llmReady) {
    log.error('LLM 未配置，请在 .env 中配置 ANTHROPIC_API_KEY 或 MINIMAX_API_KEY');
    process.exit(1);
  }

  setCurrentUser({ id: 'admin-001', username: 'admin', role: 'admin' });

  await startTelegramBot();

  // 独立进程模式：保持运行，优雅退出
  const shutdown = () => {
    log.info('\n正在关闭...');
    stopTelegramBot();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
