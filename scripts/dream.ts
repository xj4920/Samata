/**
 * scripts/dream.ts
 * Dream 手动执行入口。生产每日任务由主进程内 dream-scheduler 触发；本脚本用于
 * 运维补跑指定日期或本地验证，生成结果供 agent 后续对话参考。
 *
 * 用法：
 *   npx tsx scripts/dream.ts              # 分析昨天的数据
 *   npx tsx scripts/dream.ts 2026-05-06   # 分析指定日期
 */
import 'dotenv/config';
import { initProviders } from '../src/llm/provider.js';
import { runDreamForAll } from '../src/services/dream-analyze.js';

function getYesterdayBeijing(): string {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 3600_000 - 86400_000);
  return utc8.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const dateArg = process.argv[2];
  const dateStr = dateArg || getYesterdayBeijing();

  console.log(`[dream] ${new Date().toISOString()} 开始分析: ${dateStr}`);

  await initProviders();
  await runDreamForAll(dateStr);

  console.log(`[dream] ${new Date().toISOString()} 完成`);
}

main().catch(err => {
  console.error(`[dream] 失败: ${err.message}`);
  process.exit(1);
});
