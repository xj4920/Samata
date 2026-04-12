import type { PluginModule } from '../../src/plugins/types.js';
import { getDb } from '../../src/db/connection.js';
import { Client, STATE_LABELS } from '../../src/models/client.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function handleExportCsv(input: { filename?: string }): string {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM clients ORDER BY updated_at DESC').all() as Client[];
  if (rows.length === 0) {
    return JSON.stringify({ error: '暂无客户数据可导出' });
  }

  const header = 'ID,名称,WeWork Group,需求,销售,联系方式,状态,标签,备注,创建时间,更新时间';
  const lines = rows.map(c =>
    [c.id, c.name, c.wework_group ?? '', c.requirements ?? '', c.sales ?? '', c.contact ?? '', STATE_LABELS[c.state], c.tags ?? '', c.notes ?? '', c.created_at, c.updated_at]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  );

  const outDir = path.resolve(__dirname, '../../data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, input.filename?.trim() || 'clients.csv');
  fs.writeFileSync(outPath, [header, ...lines].join('\n'), 'utf-8');

  return JSON.stringify({
    success: true,
    rows: rows.length,
    path: outPath,
  });
}

const plugin: PluginModule = {
  name: 'export-csv',
  description: '导出客户数据为 CSV 文件',

  toolDefinitions: [
    {
      name: 'export_clients_csv',
      description: '将所有客户数据导出为 CSV 文件',
      input_schema: {
        type: 'object' as const,
        properties: {
          filename: { type: 'string', description: '输出文件名，默认 clients.csv' },
        },
        required: [],
      },
    },
  ],

  async handleTool(name, input) {
    if (name === 'export_clients_csv') return handleExportCsv(input);
    return null;
  },
};

export default plugin;
