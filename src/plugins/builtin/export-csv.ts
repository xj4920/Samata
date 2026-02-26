import type { Plugin } from '../registry.js';
import type Database from 'better-sqlite3';
import { Client } from '../../models/client.js';
import { STATE_LABELS } from '../../models/client.js';
import { log } from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const exportCsvPlugin: Plugin = {
  name: 'export-csv',
  description: '导出客户数据为CSV文件',
  execute(db: Database.Database, args: string): void {
    const rows = db.prepare('SELECT * FROM clients ORDER BY updated_at DESC').all() as Client[];
    if (rows.length === 0) {
      log.dim('暂无客户数据可导出');
      return;
    }

    const header = 'ID,名称,WeWork Group,需求,销售,联系方式,状态,标签,备注,创建时间,更新时间';
    const lines = rows.map(c =>
      [c.id, c.name, c.wework_group ?? '', c.requirements ?? '', c.sales ?? '', c.contact ?? '', STATE_LABELS[c.state], c.tags ?? '', c.notes ?? '', c.created_at, c.updated_at]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );

    const outDir = path.resolve(__dirname, '../../../data');
    const outPath = path.join(outDir, args.trim() || 'clients.csv');
    fs.writeFileSync(outPath, [header, ...lines].join('\n'), 'utf-8');
    log.success(`已导出 ${rows.length} 条客户数据到: ${outPath}`);
  },
};
