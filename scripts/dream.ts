/**
 * scripts/dream.ts
 * 每日 dream 回顾脚本 —— 通过 crontab 触发，分析前一天的 tool 使用遥测数据，
 * 生成经验教训写入 data/dreams/{agentName}.md，供 agent 下次对话参考。
 *
 * 用法：
 *   npx tsx scripts/dream.ts              # 分析昨天的数据
 *   npx tsx scripts/dream.ts 2026-05-06   # 分析指定日期
 *
 * Crontab（凌晨 3 点执行）：
 *   0 3 * * * cd /home/xj/work/source/samata && npx tsx scripts/dream.ts >> logs/dream.log 2>&1
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
