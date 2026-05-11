/**
 * 一次性脚本：从本地 PG 读取 SSE 交易日到 config/trading-calendar-sse.json
 *
 * 用法：npx tsx scripts/sync-trading-calendar.ts
 * 依赖：pg（devDependencies，仅本脚本使用）
 *
 * 默认连接本地 Docker wind_sync PG（只读用户 wind_reader），
 * 也可通过环境变量覆盖：PG_HOST / PG_PORT / PG_USER / PG_PASS / PG_DATABASE
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

// pg 是 dev-only 依赖，动态 import 避免生产代码引入
const pg = await import('pg');

function getConnectionConfig() {
  const env = (key: string, fallback: string) => process.env[key] ?? fallback;

  return {
    host: env('PG_HOST', '127.0.0.1'),
    port: parseInt(env('PG_PORT', '5432'), 10),
    user: env('PG_USER', 'wind_reader'),
    password: env('PG_PASS', 'wind_reader'),
    database: env('PG_DATABASE', 'wind_sync'),
  };
}

async function main() {
  const config = getConnectionConfig();
  const pool = new pg.Pool(config);

  try {
    const result = await pool.query(
      `SELECT "TRADE_DAYS" FROM "ASHARECALENDAR" WHERE "S_INFO_EXCHMARKET"='SSE' ORDER BY "TRADE_DAYS"`
    );

    const days = result.rows.map((r: any) => {
      const d = r.TRADE_DAYS;
      // PG DATE 类型可能返回 Date 对象或字符串
      if (d instanceof Date) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
      // 字符串可能是 '2023-01-02' 或 '20230102'
      const s = String(d);
      return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
    });

    const output = {
      exchange: 'SSE',
      generated_at: new Date().toISOString().slice(0, 10),
      description: '上海证券交易所交易日历，包含周末调休上班日',
      days,
    };

    const outputPath = join(process.cwd(), 'config', 'trading-calendar-sse.json');
    writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

    console.log(`✅ 写入 ${days.length} 条交易日到 ${outputPath}`);
    console.log(`   覆盖范围：${days[0]} ~ ${days[days.length - 1]}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('❌ 同步失败:', e.message);
  process.exit(1);
});