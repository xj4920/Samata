import type { PluginModule } from '@samata/plugin-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ARTIFACT_DIR = path.join(os.tmpdir(), 'samata');

function escapeCsvField(v: any): string {
  const s = v == null ? '' : String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function handleExportCsv(input: {
  filename: string;
  data: Record<string, any>[];
  columns?: string[];
}): string {
  if (!input.data?.length) return JSON.stringify({ error: '数据为空' });

  const cols = input.columns ?? Object.keys(input.data[0]);
  const lines = [cols.map(escapeCsvField).join(',')];
  for (const row of input.data) {
    lines.push(cols.map(c => escapeCsvField(row[c])).join(','));
  }
  const content = lines.join('\n') + '\n';

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const filename = path.basename(input.filename || 'export.csv');
  const filePath = path.join(ARTIFACT_DIR, filename);
  fs.writeFileSync(filePath, content, 'utf-8');

  return JSON.stringify({
    success: true,
    path: filePath,
    filename,
    rows: input.data.length,
    bytes: Buffer.byteLength(content, 'utf-8'),
  });
}

const plugin: PluginModule = {
  name: 'csv-export',
  description: '将 JSON 数组导出为 CSV 文件',
  toolDefinitions: [{
    name: 'export_csv',
    description: '将 JSON 对象数组导出为 CSV 文件，自动提取表头并处理转义。',
    input_schema: {
      type: 'object' as const,
      properties: {
        filename: { type: 'string', description: '输出文件名，如 report.csv' },
        data: {
          type: 'array', items: { type: 'object' },
          description: 'JSON 对象数组，每个对象代表一行',
        },
        columns: {
          type: 'array', items: { type: 'string' },
          description: '可选，指定列名及顺序，不传则取第一行的所有 key',
        },
      },
      required: ['filename', 'data'],
    },
  }],
  async handleTool(name, input) {
    if (name === 'export_csv') return handleExportCsv(input);
    return null;
  },
};

export default plugin;
